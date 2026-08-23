/**
 * The SMTP adapter, against a real Mailpit. **Rung 2.**
 *
 * Runs the shared contract, and then reads every message **back out of
 * Mailpit** — because `send` returning without throwing proves only that a
 * server accepted bytes, not that the parts arrived or that the headers are
 * the ones we meant to write.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/shared/clock/index.js';
import { Kind, kindOf } from '../../../src/shared/errors/index.js';
import {
  draft,
  ada,
  mailerContract,
} from '../../../src/shared/mailer/mailertest.js';
import { smtpMailer } from '../../../src/shared/mailer/index.js';
import { integration } from '../../testx/gate.js';
import {
  deleteAll,
  lastTo,
  rawHeaders,
  smtpHost,
} from '../../testx/mailpit.js';

const clock = systemClock();
const { host, port } = smtpHost();

const mailer = () => smtpMailer({ host, port, clock });

integration('smtp against mailpit', () => {
  beforeEach(async () => {
    await deleteAll();
  });

  afterAll(async () => {
    await deleteAll();
  });

  describe('the shared contract', () => {
    mailerContract(() => ({
      name: 'smtp',
      mailer,
      readBack: async (to) => {
        const delivered = await lastTo(to);
        return delivered === undefined
          ? undefined
          : {
              subject: delivered.subject,
              text: delivered.text,
              html: delivered.html,
            };
      },
    }));
  });

  describe('the message that actually arrived', () => {
    it('carries both parts, not just the one the client prefers', async () => {
      await mailer().send(
        draft({
          subject: 'Both parts',
          text: 'the plain one',
          html: '<p>the rich one</p>',
        }),
      );

      const delivered = await lastTo(ada.email);

      expect(delivered?.subject).toBe('Both parts');
      expect(delivered?.text).toContain('the plain one');
      expect(delivered?.html).toContain('the rich one');
    });

    it('addresses it to who it was addressed to, and nobody else', async () => {
      await mailer().send(draft());

      const raw = await rawHeaders(ada.email);
      const bccs = raw.split('\n').filter((l) => /^bcc:/i.test(l));

      expect(bccs).toEqual([]);
      expect((await lastTo(ada.email))?.to).toEqual([ada.email]);
    });

    it('never sends the injected header, because it never sends at all', async () => {
      // The assertion that closes the loop on the security case: the contract
      // suite proves `send` rejects, and this proves nothing reached the wire.
      // A sanitising implementation would pass the first and fail this one by
      // delivering a message with a mangled display name.
      const LF = String.fromCharCode(10);
      const injected = {
        email: 'victim@example.com',
        name: `Ada${LF}Bcc: attacker@example.com`,
      };

      await mailer()
        .send(draft({ to: [injected] }))
        .catch(() => undefined);

      expect(await lastTo('victim@example.com')).toBeUndefined();
      expect(await lastTo('attacker@example.com')).toBeUndefined();
    });
  });

  describe('a failure names the host and not the credential', () => {
    it('maps an unreachable server to Unavailable, not Internal', async () => {
      // The distinction that lets `retry` and `breaker` work: `isRetryable` is
      // true for Unavailable and false for Internal, so collapsing both would
      // make every mail outage look permanent.
      const unreachable = smtpMailer({
        host: '127.0.0.1',
        // Inside this repo's range and bound by nothing — ../PORTS.md +19.
        port: 15439,
        clock,
        timeout: 1_500,
      });

      const failure = await unreachable.send(draft()).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(kindOf(failure)).toBe(Kind.Unavailable);
    });

    it('names the host and port, and never the password', async () => {
      const withSecret = smtpMailer({
        host: '127.0.0.1',
        port: 15439,
        clock,
        timeout: 1_500,
        username: 'app',
        password: {
          expose: () => 'hunter2',
          toString: () => '[redacted]',
        } as never,
      });

      const failure = await withSecret.send(draft()).then(
        () => undefined,
        (error: unknown) => error,
      );

      const printed = `${String(failure)}${JSON.stringify(
        (failure as { details?: unknown }).details,
      )}`;

      expect(printed).toContain('127.0.0.1');
      expect(printed).toContain('15439');
      expect(printed).not.toContain('hunter2');
    });
  });
});
