/**
 * One contract suite; every adapter passes it. **Test tooling** — rule `S3`.
 *
 * Three adapters with genuinely different jobs — `memory` records, `smtp`
 * delivers, `none` drops — so what they share is narrower than it looks. What
 * they do share is **everything a caller can observe from the outside**:
 * validation, the shape of a receipt, and the `Kind` a failure carries.
 *
 * The `smtp` half additionally reads the message **back out of Mailpit** and
 * asserts the parts arrived, because `send` returning without throwing proves
 * only that a server accepted bytes.
 */

import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../errors/index.js';
import { type Message } from './message.js';
import { type Mailer } from './port.js';

export interface Subject {
  readonly name: string;
  readonly mailer: () => Mailer;
  /**
   * Read a message back, if this adapter can.
   *
   * `undefined` for `none`, which has nothing to read back — and that is the
   * honest shape rather than a stub that pretends.
   */
  readonly readBack?: (
    to: string,
  ) => Promise<{ subject: string; text: string; html: string } | undefined>;
}

export const ada = { email: 'ada@example.com', name: 'Ada Lovelace' };
export const sender = { email: 'noreply@example.com', name: 'Example' };

export function draft(over: Partial<Message> = {}): Message {
  return {
    to: [ada],
    from: sender,
    subject: 'Verify your address',
    text: 'Open https://example.com/verify?token=abc to continue.',
    html: '<p>Open <a href="https://example.com/verify?token=abc">this link</a>.</p>',
    ...over,
  };
}

export function mailerContract(subject: () => Subject): void {
  describe('a sent message', () => {
    it('returns a receipt naming the adapter', async () => {
      const s = subject();

      const receipt = await s.mailer().send(draft());

      expect(receipt.id).toBeTruthy();
      expect(receipt.via).toBe(s.name);
      expect(receipt.acceptedAt).toBeInstanceOf(Date);
    });

    it('is retrievable with its rendered parts', async () => {
      const s = subject();
      if (s.readBack === undefined) return; // `none` has nothing to read back

      const sent = draft({
        subject: 'Retrievable',
        text: 'plain body https://x.test/1',
        html: '<p>rich body</p>',
      });
      await s.mailer().send(sent);

      const back = await s.readBack(ada.email);
      expect(back?.subject).toBe('Retrievable');
      expect(back?.text).toContain('plain body');
      // Both parts, always. A text-only message looks broken in a modern client
      // and an HTML-only one is unreadable in a plain-text one.
      expect(back?.html).toContain('rich body');
    });
  });

  describe('header injection is rejected', () => {
    // **The security case.** SMTP headers are CRLF-separated, so a newline in a
    // header-bound field does not corrupt a header — it adds one.
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);

    it('refuses a newline in a display name — the silent Bcc', async () => {
      const s = subject();
      const injected = {
        email: 'ada@example.com',
        name: `Ada${CR}${LF}Bcc: attacker@example.com`,
      };

      const failure = await s
        .mailer()
        .send(draft({ to: [injected] }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });

    it('refuses a newline in an address', async () => {
      const s = subject();
      const injected = {
        email: `ada@example.com${LF}Bcc: attacker@example.com`,
      };

      const failure = await s
        .mailer()
        .send(draft({ to: [injected] }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });

    it('refuses a newline in a subject — the forged From', async () => {
      const s = subject();

      const failure = await s
        .mailer()
        .send(draft({ subject: `Hello${CR}${LF}From: ceo@example.com` }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });

    it('names the field without echoing the injected value', async () => {
      // A rejected header ends up in a log; echoing it back would reproduce the
      // injection there.
      const s = subject();

      const failure = await s
        .mailer()
        .send(draft({ subject: `Hello${LF}From: ceo@example.com` }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(String(failure)).not.toContain('ceo@example.com');
      expect(
        (failure as { fields?: { field: string }[] }).fields?.map(
          (f) => f.field,
        ),
      ).toContain('subject');
    });

    it('applies to every adapter, including the one that discards', async () => {
      // An adapter that skipped validation because it was going to drop the
      // message anyway would let a bug through in staging that only appears in
      // production.
      const s = subject();

      await expect(
        s.mailer().send(draft({ subject: `x${LF}y` })),
      ).rejects.toThrow();
    });
  });

  describe('a message that is not one', () => {
    it('is refused with every problem at once', async () => {
      const s = subject();

      const failure = await s
        .mailer()
        .send(draft({ subject: '', text: '', html: '' }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
      const fields = (failure as { fields?: { field: string }[] }).fields ?? [];
      expect(fields.map((f) => f.field).sort()).toEqual([
        'html',
        'subject',
        'text',
      ]);
    });

    it('refuses a message with no recipient', async () => {
      const s = subject();

      const failure = await s
        .mailer()
        .send(draft({ to: [] }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });

    it('refuses an address that is not one', async () => {
      const s = subject();

      const failure = await s
        .mailer()
        .send(draft({ to: [{ email: 'not-an-address' }] }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });
  });
}
