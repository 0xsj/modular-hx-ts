/**
 * One contract suite; every adapter passes it. **Test tooling** — rule `S3`.
 *
 * `CONTEXTS.md` §8 step 4: implement in `infra/memory`, then `infra/postgres`,
 * **same suite**. Separate tests would prove both adapters work; one suite run
 * twice proves they *agree*, which is the property that lets `STORAGE=memory`
 * be a real mode rather than a demo.
 *
 * The cases here are the ones where an adapter can be plausibly wrong: the
 * unique address, the version check, and the revoke sweep. Everything the
 * aggregate decides is tested against the aggregate, not through a repository.
 */

import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../../../shared/errors/index.js';
import {
  type Email,
  type UserId,
  ApiKey,
  AuthMethod,
  Challenge,
  Purpose,
  Session,
  User,
  apiKeyId,
  challengeId,
  email,
  passwordHash,
  role,
  sessionId,
  userId,
} from '../domain/index.js';
import { type Transactor, type Work } from './ports.js';

export interface Subject {
  readonly name: string;
  /** A fresh unit of work over the shared store. */
  readonly transactor: Transactor;
  /** Reads outside a unit, the way queries do. */
  readonly read: () => Omit<Work, 'publish'>;
}

let counter = 0;
const nextEmail = (): Email => email(`case-${String(++counter)}@example.com`);
const nextUserId = (): UserId =>
  userId(`01a024c7-0000-7000-8000-${String(++counter).padStart(12, '0')}`);
const nextSessionId = () =>
  sessionId(`01a024c7-1111-7000-8000-${String(++counter).padStart(12, '0')}`);
const nextChallengeId = () =>
  challengeId(`01a024c7-5555-7000-8000-${String(++counter).padStart(12, '0')}`);
const nextApiKeyId = () =>
  apiKeyId(`01a024c7-6666-7000-8000-${String(++counter).padStart(12, '0')}`);

const AT = new Date('2026-08-24T12:00:00.000Z');
const LATER = new Date('2026-08-24T13:00:00.000Z');

function newUser(address = nextEmail()): User {
  return User.register(
    nextUserId(),
    address,
    passwordHash('argon2:stored'),
    AT,
  );
}

function newSession(owner: UserId, fingerprint: string): Session {
  return Session.issue(
    nextSessionId(),
    owner,
    fingerprint,
    AuthMethod.Password,
    AT,
    // Well past `LATER`. An expiry that lands *on* the instant the assertions
    // use makes every liveness case fail for the fixture's reason rather than
    // the adapter's — which is how a suite ends up asserting its own arithmetic.
    new Date(AT.getTime() + 24 * 3_600_000),
  );
}

/**
 * Narrow, or fail the test where the absence happened.
 *
 * A `!` would satisfy the compiler and blame the *next* line when the value is
 * missing; this fails at the read, which is where the information is.
 */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

async function kindOfThrow(fn: () => Promise<unknown>): Promise<Kind> {
  try {
    await fn();
  } catch (error) {
    return kindOf(error);
  }
  throw new Error('expected a failure and got none');
}

export function identityStoreContract(subject: () => Subject): void {
  describe('users', () => {
    it('round-trips everything the aggregate holds', async () => {
      const s = subject();
      const user = newUser();
      user.grantRole(role('admin'), AT);

      await s.transactor.within((work) => work.users.create(user));
      const loaded = await s.read().users.byId(user.id);

      expect(loaded?.toState()).toEqual(user.toState());
    });

    it('finds a user by their normalized address', async () => {
      const s = subject();
      const user = newUser();

      await s.transactor.within((work) => work.users.create(user));

      expect((await s.read().users.byEmail(user.email))?.id).toBe(user.id);
    });

    it('answers undefined rather than throwing for an unknown id', async () => {
      // The login path branches on this, and an exception there would be a
      // different code path for an unknown address — case 7's oracle.
      const s = subject();

      expect(await s.read().users.byId(nextUserId())).toBeUndefined();
      expect(await s.read().users.byEmail(nextEmail())).toBeUndefined();
    });

    it('refuses a duplicate address with a Conflict', async () => {
      // §2.1: uniqueness is the repository's job. A read-then-insert has a
      // window, and the window is exactly the concurrent-signup case.
      const s = subject();
      const address = nextEmail();

      await s.transactor.within((work) => work.users.create(newUser(address)));

      expect(
        await kindOfThrow(() =>
          s.transactor.within((work) => work.users.create(newUser(address))),
        ),
      ).toBe(Kind.Conflict);
    });

    it('writes on (id, baseVersion) and bumps the stored version', async () => {
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));

      user.disable(LATER);
      await s.transactor.within((work) => work.users.save(user));

      const loaded = await s.read().users.byId(user.id);
      expect(loaded?.version).toBe(2);
      expect(loaded?.enabled).toBe(false);
    });

    it('refuses a stale write with a Conflict', async () => {
      // ARCHITECTURE.md §3 rule 7. Two callers loaded version 1; the second to
      // save loses, rather than silently overwriting the first.
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));

      const mine = await s.read().users.byId(user.id);
      const theirs = await s.read().users.byId(user.id);

      mine?.disable(LATER);
      await s.transactor.within((work) =>
        work.users.save(present(mine, 'the user')),
      );

      theirs?.grantRole(role('admin'), LATER);

      expect(
        await kindOfThrow(() =>
          s.transactor.within((work) =>
            work.users.save(present(theirs, 'the user')),
          ),
        ),
      ).toBe(Kind.Conflict);
    });

    it('survives two mutations before one save', async () => {
      // The reason the aggregate keeps `baseVersion` separate from `version`:
      // `where version = version - 1` is right for one mutation and silently
      // wrong for two.
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));

      const loaded = present(await s.read().users.byId(user.id), 'the user');
      loaded.disable(LATER);
      loaded.grantRole(role('admin'), LATER);

      await s.transactor.within((work) => work.users.save(loaded));

      expect((await s.read().users.byId(user.id))?.version).toBe(3);
    });
  });

  describe('challenges', () => {
    const secret = (seed: string): string => `sha256:${seed.repeat(64)}`;

    async function issued(
      s: Subject,
      owner: UserId,
      purpose: Purpose,
      seed: string,
      sourceEventId?: string,
    ): Promise<Challenge> {
      const challenge = Challenge.issue(
        nextChallengeId(),
        owner,
        purpose,
        secret(seed),
        'v1.dev.tag',
        AT,
        // 24 hours, not one: an expiry landing exactly on `LATER` makes every
        // liveness case fail for the fixture's arithmetic rather than the
        // adapter's. Already paid for once, on sessions.
        new Date(AT.getTime() + 24 * 3_600_000),
        '',
        sourceEventId,
      );
      await s.transactor.within((work) => work.challenges.create(challenge));
      return challenge;
    }

    it('finds one by fingerprint, never by secret', async () => {
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));
      const challenge = await issued(s, user.id, Purpose.ResetPassword, 'a');

      const found = await s.read().challenges.byFingerprint(secret('a'));
      expect(found?.id).toBe(challenge.id);
    });

    it('refuses a second consume — case 13 under concurrency', async () => {
      // The aggregate refuses a second consume in process; this is the store
      // refusing it across two of them, which is what makes single-use real.
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));
      await issued(s, user.id, Purpose.ResetPassword, 'b');

      const mine = await s.read().challenges.byFingerprint(secret('b'));
      const theirs = await s.read().challenges.byFingerprint(secret('b'));

      mine?.consume(LATER, Purpose.ResetPassword);
      await s.transactor.within((work) =>
        work.challenges.save(present(mine, 'the challenge')),
      );

      theirs?.consume(LATER, Purpose.ResetPassword);
      expect(
        await kindOfThrow(() =>
          s.transactor.within((work) =>
            work.challenges.save(present(theirs, 'the challenge')),
          ),
        ),
      ).toBe(Kind.Conflict);
    });

    it('expires the outstanding ones of ONE purpose — case 14', async () => {
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));
      await issued(s, user.id, Purpose.ResetPassword, 'c');
      await issued(s, user.id, Purpose.ResetPassword, 'd');
      await issued(s, user.id, Purpose.VerifyEmail, 'e');

      const expired = await s.transactor.within((work) =>
        work.challenges.expireOutstanding(
          user.id,
          Purpose.ResetPassword,
          LATER,
        ),
      );

      expect(expired).toBe(2);
      // The other purpose survives: a reset must not silently invalidate a
      // verification link the user is about to click.
      expect(
        (await s.read().challenges.byFingerprint(secret('e')))?.isUsableAt(
          LATER,
        ),
      ).toBe(true);
    });

    it('refuses a second challenge for one source event — §7.7', async () => {
      // Idempotency **modelled, not middleware**: at-least-once delivery means
      // a subscriber sees duplicates, and a unique column makes that safe.
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));
      const event = `01a024c7-3333-7000-8000-${String(++counter).padStart(12, '0')}`;

      await issued(s, user.id, Purpose.VerifyEmail, 'f', event);

      expect(
        await kindOfThrow(() =>
          issued(s, user.id, Purpose.VerifyEmail, 'g', event),
        ),
      ).toBe(Kind.Conflict);
    });

    it('finds one by its source event', async () => {
      const s = subject();
      const user = newUser();
      await s.transactor.within((work) => work.users.create(user));
      const event = `01a024c7-4444-7000-8000-${String(++counter).padStart(12, '0')}`;
      const challenge = await issued(s, user.id, Purpose.MagicLink, 'h', event);

      expect((await s.read().challenges.bySourceEvent(event))?.id).toBe(
        challenge.id,
      );
    });
  });

  describe('api keys', () => {
    const print = (seed: string): string => `sha256:${seed.repeat(64)}`;

    it('round-trips scopes and finds by fingerprint', async () => {
      const s = subject();
      const user = newUser();
      const key = ApiKey.issue(
        nextApiKeyId(),
        user.id,
        'ci',
        print('1'),
        ['user:read', 'user:write'],
        AT,
      );

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.apiKeys.create(key);
      });

      const found = await s.read().apiKeys.byFingerprint(print('1'));
      expect(found?.scopes).toEqual(['user:read', 'user:write']);
    });

    it('lists a user`s keys and nobody else`s', async () => {
      const s = subject();
      const mine = newUser();
      const theirs = newUser();

      await s.transactor.within(async (work) => {
        await work.users.create(mine);
        await work.users.create(theirs);
        await work.apiKeys.create(
          ApiKey.issue(nextApiKeyId(), mine.id, 'a', print('2'), [], AT),
        );
        await work.apiKeys.create(
          ApiKey.issue(nextApiKeyId(), theirs.id, 'b', print('3'), [], AT),
        );
      });

      expect(await s.read().apiKeys.listFor(mine.id)).toHaveLength(1);
    });

    it('round-trips revocation', async () => {
      const s = subject();
      const user = newUser();
      const key = ApiKey.issue(
        nextApiKeyId(),
        user.id,
        'ci',
        print('4'),
        [],
        AT,
      );

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.apiKeys.create(key);
      });

      key.revoke(LATER);
      await s.transactor.within((work) => work.apiKeys.save(key));

      const loaded = await s.read().apiKeys.byId(key.id);
      expect(loaded?.isValidAt(LATER)).toBe(false);
    });
  });

  describe('sessions', () => {
    it('finds a session by fingerprint, never by token', async () => {
      const s = subject();
      const user = newUser();
      const session = newSession(user.id, `sha256:${'a'.repeat(64)}`);

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.sessions.create(session);
      });

      const found = await s
        .read()
        .sessions.byFingerprint(session.tokenFingerprint);
      expect(found?.id).toBe(session.id);
    });

    it('round-trips revocation and last-seen', async () => {
      const s = subject();
      const user = newUser();
      const session = newSession(user.id, `sha256:${'b'.repeat(64)}`);

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.sessions.create(session);
      });

      session.revoke(LATER);
      await s.transactor.within((work) => work.sessions.save(session));

      const loaded = await s.read().sessions.byId(session.id);
      expect(loaded?.revokedAt?.toISOString()).toBe(LATER.toISOString());
      expect(loaded?.isValidAt(LATER)).toBe(false);
    });

    it('lists only the live ones', async () => {
      const s = subject();
      const user = newUser();
      const live = newSession(user.id, `sha256:${'c'.repeat(64)}`);
      const dead = newSession(user.id, `sha256:${'d'.repeat(64)}`);
      dead.revoke(AT);

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.sessions.create(live);
        await work.sessions.create(dead);
      });

      const listed = await s.read().sessions.listActive(user.id, AT);
      expect(listed.map((one) => one.id)).toEqual([live.id]);
    });

    it('revokes every session for a user and reports how many', async () => {
      const s = subject();
      const user = newUser();
      const sessions = ['e', 'f', 'g'].map((seed) =>
        newSession(user.id, `sha256:${seed.repeat(64)}`),
      );

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        for (const one of sessions) await work.sessions.create(one);
      });

      const revoked = await s.transactor.within((work) =>
        work.sessions.revokeAll(user.id, LATER),
      );

      expect(revoked).toBe(3);
      expect(await s.read().sessions.listActive(user.id, LATER)).toEqual([]);
    });

    it('spares the one it is told to — case 9', async () => {
      // The whole difference between a password change and a password reset.
      const s = subject();
      const user = newUser();
      const mine = newSession(user.id, `sha256:${'h'.repeat(64)}`);
      const theirs = newSession(user.id, `sha256:${'i'.repeat(64)}`);

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.sessions.create(mine);
        await work.sessions.create(theirs);
      });

      const revoked = await s.transactor.within((work) =>
        work.sessions.revokeAll(user.id, LATER, mine.id),
      );

      expect(revoked).toBe(1);
      expect(
        (await s.read().sessions.listActive(user.id, LATER)).map((o) => o.id),
      ).toEqual([mine.id]);
    });

    it('counts what it ended, not what it found', async () => {
      // An already-revoked session must not inflate the number
      // `PasswordChanged` reports.
      const s = subject();
      const user = newUser();
      const live = newSession(user.id, `sha256:${'j'.repeat(64)}`);
      const already = newSession(user.id, `sha256:${'k'.repeat(64)}`);
      already.revoke(AT);

      await s.transactor.within(async (work) => {
        await work.users.create(user);
        await work.sessions.create(live);
        await work.sessions.create(already);
      });

      expect(
        await s.transactor.within((work) =>
          work.sessions.revokeAll(user.id, LATER),
        ),
      ).toBe(1);
    });

    it('does not touch another user`s sessions', async () => {
      const s = subject();
      const mine = newUser();
      const theirs = newUser();

      await s.transactor.within(async (work) => {
        await work.users.create(mine);
        await work.users.create(theirs);
        await work.sessions.create(
          newSession(mine.id, `sha256:${'l'.repeat(64)}`),
        );
        await work.sessions.create(
          newSession(theirs.id, `sha256:${'m'.repeat(64)}`),
        );
      });

      await s.transactor.within((work) =>
        work.sessions.revokeAll(mine.id, LATER),
      );

      expect(await s.read().sessions.listActive(theirs.id, LATER)).toHaveLength(
        1,
      );
    });
  });
}
