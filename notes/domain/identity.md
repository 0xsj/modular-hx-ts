---
context: identity
---

# Identity

## What

The first bounded context, and the one that exercises the whole vertical:
transport → validation → domain invariants → persistence → events → mail →
authz. Users, sessions, roles, credentials and the emailed-secret lifecycle.

Four aggregates: `User`, `Session`, `Challenge`, `ApiKey`. Conformance cases
5–17.

## Why

### A user is not their credentials

`passwordHash` is optional, and a user with none is a normal user rather than a
broken one. That single `| undefined` is what makes SSO, passkeys and MFA
additive rather than a rewrite — and it is the precondition for the convergence
point below.

The alternative forces an invented value for every user who arrives another way:
a random unusable string, a sentinel, a nullable column read as empty. Each is a
lie somebody eventually compares against.

### The convergence point, built with one caller

**Every authentication method ends in `Session.issue` + `UserAuthenticated`.**
Today there is one method; by the end of slice 3 there were two, and the second
— magic link — is nine lines.

That is the whole argument, and it is easier to see now than it will ever be
again. `authenticate` owns the TTL, the token, the fingerprinting, the
`enabled` check and both events. A method supplies a `User` and a name.

**It is hard to add later for a reason that is not technical.** By the time a
second method exists, the first one's session creation is inlined in a login
handler; the second copies it; the third copies whichever it found. Then three
places decide a session's TTL, three publish `SessionCreated`, and the one that
forgot to check `enabled` is the one somebody logs in through. The magic-link
path inheriting the disabled check without knowing it made one is the dividend,
and it has a test.

### Two aggregates, not `User.Sessions`

Sessions are written far more often than users and have their own lifecycle; the
only thing crossing the boundary is a foreign key — §2.2, and §7.3's rule that
aggregate boundaries follow write frequency rather than the object graph.

**Modelled as a collection on `User`, every login would bump the user's
version.** Every `Touch` would contend with a role grant. The
optimistic-concurrency token would be useless for the thing it is actually for,
and `If-Match` on a user would fail because somebody logged in on their phone.

### One `Challenge`, many purposes

Verify email, reset password, change email, magic link. §7.5's test is whether
the **issue-and-consume rules** are the same, and they are: mint a secret, tag
it, expire it, consume it once. What differs is what happens *after* a consume
succeeds, and that is a handler rather than an aggregate.

Four aggregates would be four copies of single-use, four copies of the TTL, and
four copies of the one-indistinguishable-error rule. The copy that drifted would
be the one that forgot.

**The purpose is inside the MAC**, which is what makes the discriminant load-
bearing rather than decorative: without it a `reset_password` secret and a
`magic_link` secret are interchangeable, and the weaker flow becomes the way
into the stronger one.

### The two that look alike and are not

Conformance cases 9 and 14 are the pair most likely to be conflated, so both are
tested and each names the other:

| | revokes | why |
| --- | --- | --- |
| password **change** (case 9) | every session **except the caller's** | they proved they know the old password, so they are not the threat; logging them out of the device they are typing on is a usability tax with no security benefit |
| password **reset** (case 14) | **every** session, **and the user's other outstanding reset links** | they proved only that they control the mailbox, and the person holding a live session might be exactly who this is defending against |

The second half of case 14 is the one that gets forgotten. A second link mailed
an hour earlier is still live, and whoever triggered it still has it.

### Case 7 is about timing, and the test counts rather than measures

Wrong password and unknown address must return the identical status, body **and
timing class**. A login that skips verification when the address is unknown
returns measurably faster, and an attacker reads that off a stopwatch without
ever authenticating.

So `Hasher` exposes a **`dummy` value rather than a `verifyDummy()` method**:
the command calls the same `verify` either way, so the two paths are one code
path with a different argument. A separate method is a separate code path, and a
separate code path is where the timing difference comes back.

**The test counts verifications rather than timing them.** A wall-clock
assertion on a memory-hard hash is flaky by construction, and a flaky assertion
gets loosened until it asserts nothing or deleted outright. The property is *the
same work happens*; counting the work states it directly. The first version of
this test compared status and body only, and a sweep showed it passing against a
login that skipped the hash entirely.

Three quieter paths take the same route: a **malformed** address, a password
that fails the length policy, and a user with no password at all. Each would
otherwise be an oracle wearing a different status code.

### Roles are read per request, which is case 12 for free

§2.2 chose fixed TTL plus revocation over JWT. The session carries no roles, so
`resolveCaller` reads them fresh every time — and *roles assigned through the API
take effect on the next request* needs no code, no token reissue and no cache to
invalidate. A JWT design has to solve this, and the usual solution is a short TTL
that makes the case **nearly** true.

**There is no route that can grant the first administrator**, and that is the
design rather than a gap: every role route is authorized, so a caller with no
roles cannot grant themselves one. The first admin arrives by migration or by an
operator command. The end-to-end test seeds it directly and says so.

### Scopes subtract; this context does almost nothing to make that true

Case 17's intersection is `authz`'s, computed from `Subject.scopes`. What
`identity` does is build the subject from the **owner's roles** with the
**key's scopes** attached — never from the key's scopes instead, which would
make a scope a grant and invert the case.

That distinction is where the test was initially wrong: the first version built
a `Subject` by hand and asserted `authz` intersected correctly, which tests
`authz`. Dropping the scopes from `subjectOf` changed nothing it saw. The test
now asserts the half this context owns.

## Gotchas

**The URL surface is not this context's to choose.** `CONFORMANCE.md` §3.5:
`/v1/<resource>`, and **a context must not appear in a path**. These routes were
`/identity/*`, which is a client reading the architecture off a URL — the one
thing holding the domain constant exists to keep out of the comparison. It also
makes splitting or merging a context a breaking API change instead of an
internal move nobody outside notices, and `modular-vs` has no contexts to name,
so a convention it cannot follow is not a collection convention.

The four link-request routes collapsed into one `POST /v1/links` with the
purpose in the body, which is where it belonged: four paths differing only by a
slug were four ways to spell one request. The route declares `anonymous` and
checks in the handler, because three purposes must work with no credential — a
password reset the logged-out user cannot request is not a password reset — and
`change_email` needs one. The registry cannot express *sometimes*, and should
not: it would have to read the body to decide, which is the router doing the
route's job.

**The bootstrap path is `ensureUser`, and it is not reachable over HTTP.**
`CONTEXTS.md` §7.4: granting a role needs a role, so an empty database cannot
reach one. It takes roles as an argument and has no opinion about which — the
composition root names them, because the process that compiled the policy is the
only thing that knows what a role means. It registers through the same command
the public route uses, so the account is a real user with a real hash rather
than a row written behind the domain's back, and a duplicate address is the
idempotent case rather than a failure.

**A registered user holds no role unless the root says so.** `register` takes
the roles as input and the route supplies none, so `roles: []` — and `member` in
the process's policy meant nothing, because nobody was a member. The visible
symptom was a 403 from `/v1/audit` for every user who had just signed up,
on the one permission the policy grants everybody.

`makeIdentity({ defaultRoles })` fixes it, and the shape matters: **the context
never invents a role**. Which roles a signup confers is a product decision, and
the only thing that knows what a role *means* is whatever compiled the policy —
the composition root. The empty default is the honest one.

It is deliberately not on `RegisterBody`. An anonymous request naming its own
roles is privilege escalation with extra steps.

- **`domain/` may import only `errors`** — rule `S7` — so value objects
  **throw** rather than returning a `Result`. That reads differently from
  `src/shared`, where everything returns one. Worth knowing that
  `ARCHITECTURE.md` §L0 calls `errors` *and* `result` the kernel's vocabulary
  while `ENFORCEMENT.md` `S7` permits only `errors` — a gap that matters in a
  language with a `Result` type and not in Go. Followed as written; raised
  rather than widened.
- **`Password` is a class, not a branded string.** §2.1 requires it to redact in
  *every* string form, and a branded primitive prints itself. `toString`,
  `toJSON` and Node's inspect hook are all covered; `reveal()` is the only way
  out and is named so that reading the secret is visible at the call site.
- **The whole address is lowercased**, not just the domain. Formally the local
  part is case-sensitive; in practice no provider treats it that way, and
  preserving the distinction means `Bob@x.com` can register while `bob@x.com` is
  taken.
- **`baseVersion` is separate from `version`.** A repository writes on
  `(id, baseVersion)`. Collapsing them into `where version = version - 1` is
  right for one mutation and silently wrong for two, which the contract suite
  checks.
- **An API key is refused by default**, and routes opt in with
  `apiKeys: 'allowed'`. Case 16 names three endpoints — key management, logout,
  password change — and the default is what makes it true for those three
  without anybody remembering. The refusal is **403, not 401**: the credential
  is valid and the caller identified; this endpoint does not accept this *kind*
  of credential, and a 401 would invite them to present it again.
- **Keys carry an `ak_` prefix**, so a leaked one is findable by a secret
  scanner and so one bearer scheme can carry two credential kinds without a
  second header to get wrong.
- **The aggregate's purpose check duplicates the app's**, deliberately, and it
  has its own test for a reason a sweep found: with the app check in place,
  breaking the aggregate's changed no end-to-end behaviour. An untested guard is
  a guard somebody deletes as redundant.
- **The memory `Transactor` is not atomic**, and says so. The contract suite
  deliberately does not assert rollback — a suite that "proved" atomicity
  against three `Map`s would give exactly the confidence that must not be given.
  The PostgreSQL integration test asserts it where it is real.
- **Contract fixtures expiring exactly on the assertion instant** cost two
  debugging rounds, once on sessions and once on challenges. The expiry is now
  a day out in both.

## The defect that only this layer could find

The router resolved the bearer token itself. Every authenticated route returned
the right thing, every command had the right user, every repository wrote the
right row — and the chain's provenance still said `anonymous:`, so **every event
`identity` published named no actor.** `audit` would have recorded *somebody
disabled this account* with no answer to *who*.

Nothing below the edge could have caught it, because nothing below the edge was
wrong. The fix is to authenticate where the chain says to: position 6 sets the
actor, and the router reads what it resolved. `transport/http/authn.ts` carries
the story, and the §2.5 test that asserts an administrator's id on a
`role_granted` envelope is what fails if it comes back.

## Used in

- `src/contexts/identity/index.ts` — the context root, and the only way in.

Mounted by the composition root behind `httpx`'s chain: `identity.authenticate`
at position 6, `identity.validators` into `conditional`, `identity.handler` as
the handler, and `identity.migrations` in the migration set. Nothing else may
reach it — rules `S5` and `S6`.

## Related

[[provenance]] — the actor on every envelope, and the defect above.
[[events]] — the outbox row written in the same transaction as the data write.
[[postgres]] — the unique index that makes uniqueness the repository's job.
[[conditional]] — this context is its first implementer; the tag is over the
representation rather than the version. [[idempotency]] — position 9, and the
release rule the reset path leans on. [[authz]] — the intersection case 17
needs, and the `Subject` this context builds. [[crypto]] — the MAC binding a
challenge to its user and purpose. [[random]] — every session token, API key and
challenge secret. [[digest]] — the fingerprint that is all the store ever holds.
[[mailer]] — behind `ChallengeMailer`, so case 15 is testable without a server.
