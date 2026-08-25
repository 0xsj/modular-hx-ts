/**
 * The `Challenge` aggregate, on its own.
 *
 * **These exist because a sweep found the app layer shadowing them.** The
 * consume-side checks are duplicated — `claim()` in `app/command/challenges.ts`
 * verifies the purpose before calling `consume`, so breaking the aggregate's
 * own check changed no end-to-end behaviour and no test noticed.
 *
 * That duplication is deliberate defence in depth: the app check catches a
 * caller presenting a secret at the wrong endpoint, and the aggregate's catches
 * a *future* caller that forgets to. But an untested guard is a guard somebody
 * deletes as redundant, so it is tested where it lives.
 */

import { describe, expect, it } from 'vitest';
import { kindOf, Kind } from '../../../shared/errors/index.js';
import { Challenge, Purpose } from './challenge.js';
import { challengeId, userId } from './ids.js';

const ID = challengeId('01a024c7-7777-7000-8000-000000000001');
const OWNER = userId('01a024c7-8888-7000-8000-000000000001');
const AT = new Date('2026-08-24T12:00:00.000Z');
const WITHIN = new Date('2026-08-24T12:30:00.000Z');
const AFTER = new Date('2026-08-24T14:00:00.000Z');

const issued = (purpose: Purpose = Purpose.ResetPassword): Challenge =>
  Challenge.issue(
    ID,
    OWNER,
    purpose,
    'sha256:abc',
    // Not dot-shaped: `M6` reads any `a.b.c` literal inside `domain/` as an
    // event name, and it is right to — a test asserting a wrongly-prefixed
    // event should fail. A MAC tag that happens to look like one is the
    // fixture's problem, not the rule's.
    'v1-dev-tag',
    AT,
    new Date(AT.getTime() + 3_600_000),
  );

describe('single use', () => {
  it('consumes once', () => {
    const challenge = issued();

    challenge.consume(WITHIN, Purpose.ResetPassword);

    expect(challenge.consumedAt).toEqual(WITHIN);
    expect(challenge.isUsableAt(WITHIN)).toBe(false);
  });

  it('refuses the second consume', () => {
    const challenge = issued();
    challenge.consume(WITHIN, Purpose.ResetPassword);

    expect(() => {
      challenge.consume(WITHIN, Purpose.ResetPassword);
    }).toThrow();
  });
});

describe('the purpose is part of the guard', () => {
  it('refuses a secret presented for another purpose', () => {
    // **The check the app layer shadows.** Without it, a reset secret is a
    // magic link — and the weaker flow becomes the way into the stronger one.
    const challenge = issued(Purpose.ResetPassword);

    expect(() => {
      challenge.consume(WITHIN, Purpose.MagicLink);
    }).toThrow();
    expect(challenge.consumedAt).toBeUndefined();
  });

  it('does not consume it as a side effect of refusing', () => {
    // A guard that spends the challenge before refusing turns a probe into a
    // denial of service against the legitimate holder.
    const challenge = issued(Purpose.ResetPassword);

    expect(() => {
      challenge.consume(WITHIN, Purpose.VerifyEmail);
    }).toThrow();
    expect(() => {
      challenge.consume(WITHIN, Purpose.ResetPassword);
    }).not.toThrow();
  });
});

describe('every failure is one indistinguishable error — case 13', () => {
  it('is the same Kind and message for expired, consumed and wrong purpose', () => {
    const expired = issued();
    const consumed = issued();
    consumed.consume(WITHIN, Purpose.ResetPassword);
    const wrongPurpose = issued();

    const failures = [
      capture(() => {
        expired.consume(AFTER, Purpose.ResetPassword);
      }),
      capture(() => {
        consumed.consume(WITHIN, Purpose.ResetPassword);
      }),
      capture(() => {
        wrongPurpose.consume(WITHIN, Purpose.MagicLink);
      }),
    ];

    for (const failure of failures) {
      expect(kindOf(failure)).toBe(Kind.Invalid);
      expect(failure.message).toBe(failures[0]?.message);
    }
  });
});

function capture(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure and got none');
}
