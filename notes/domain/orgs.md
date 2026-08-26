---
context: orgs
---

# Orgs — a role per organization

## What

Organizations, the memberships that put people in them, and the invitations
that get people there. Found, invite, accept, change role, leave, archive.

Three aggregates and one function: `Organization`, `Membership`, `Invitation`,
and `assertOwnerRemains` — which is not an aggregate and is the most interesting
thing in the context.

## Why

### A role is per organization, and that is the reason this exists

`CONTEXTS.md` §4: *a user belongs to several orgs with a different role in each,
so authorization reads their role in the organization the resource belongs to,
not a flat account role — without it, `authz` gets modelled wrong.*

The failure it prevents is not subtle once you see it. With a flat account role,
the same person is either an admin or not; with organizations, the same person
is an owner of theirs and a member of yours, and **the same request has two
answers depending on which organization the resource is in**.

Encoding org roles into an authz `Subject` was the alternative and it does not
work: a `Subject` carries one set of roles for the whole request, so it would
need one subject per organization, and the number of organizations a caller
belongs to is not known when the subject is built. So `app/authorize.ts` reads
the roster. It is a lookup rather than a table, and every context built after
this one inherits that shape.

**An account administrator is not an organization owner.** Nothing in this
context consults an account role, and the omission is the design rather than a
gap: `identity`'s `admin` says what somebody may do to the *system*, and
conferring ownership of somebody else's organization is not that.

### One owner always — the first invariant that spans a set

`CONTEXTS.md` §7.1 observes that every invariant in v1 was **intra-aggregate**:
a rule one object could check by looking at itself. This one is not. *At least
one owner* is a property of the membership **set**, and no single `Membership`
can see enough to enforce it.

Three places it could live, and why `domain/roster.ts` is the one:

- **On `Membership`.** It would have to hold every sibling to answer, which is
  the wrong boundary wearing the right name — an aggregate that needs the whole
  collection **is** the whole collection.
- **On `Organization`, holding the roster.** The textbook answer, and wrong at
  any real size: every role change would load and write the entire membership
  list to protect one row, and the organization's version would move every time
  anybody joined. The concurrency token would stop meaning anything.
- **A pure function over a roster snapshot**, called by the command *inside the
  transaction that already read it*. No I/O, no aggregate, no second read — and
  `S7` holds, because it imports only `errors`.

**The lock is proved, not assumed.** `tests/integration/orgs/postgres.test.ts`
holds one transaction open past its roster read, lets a second issue its own,
and only then commits the first. Removing `for update` fails it. The first
version of that test released the held transaction *before* the second had
issued its read, so the first committed, the second read one owner and refused
for the ordinary reason — it passed with the lock removed and proved nothing.
Only a deliberate break showed that, which is the argument for breaking every
test that claims a concurrency property.

**The transaction is what makes it correct rather than probable.** The command
reads the roster and writes in one transaction, so the set it checks is the set
it changes; the PostgreSQL adapter reads it `for update`, which locks the rows
the check reasons about. Checking outside the transaction is a
time-of-check-to-time-of-use race with a very specific loss: two concurrent
demotions of two *different* owners, each seeing two owners, and an organization
left with none. There is a test for exactly that sequence.

**One function for demote, remove and leave.** §4 names all three, and they are
the same question asked three ways. Three separate checks is how the third one
ends up missing the case the first two cover.

### Invitations are the `Challenge` shape, and not the `Challenge` code

§4 calls them *the `Challenge` shape again*, and the obvious move is to import
`identity`'s. **That is not possible, and the rule that forbids it is right.**

`S7` permits a context's `domain/` exactly one import: `errors`. No shared
module is reachable from where an aggregate lives, so neither `identity`'s class
nor a promoted one could be used here. An aggregate **is** a context's model of
its own world; two contexts sharing one would be two contexts with one model,
and a change to this context's expiry rules would be a change to `identity`'s.

What is genuinely common has no domain in it — mint a secret, fingerprint it,
bind a MAC message — and that **was** promoted, to `shared/token`. See
[[token]]. The shape is reused; the model is not.

**The finding this produced is about the first implementation, not this one.**
`identity` put the token mechanics next to an aggregate, which was the right
size while it was the only context. A mechanism and a special case are
indistinguishable until something else needs the mechanism.

### The port `identity` declares and this context satisfies

> Identity learns a caller's org roles through a port the root wires, so neither
> context imports the other, and `ORGS_ENABLED=false` is a working
> configuration.

Three load-bearing things in one sentence:

- **Declared by the consumer.** `identity/app/ports.ts` names `OrgRoles`
  without knowing anything satisfies it. `app/query/roles.ts` here satisfies it
  without knowing who asked.
- **Wired by the root.** `src/wire.ts` is the only file that sees both, so `S6`
  holds structurally rather than by inspection.
- **The absence is a valid configuration**, and that is the part that proves the
  seam is real. If `ORGS_ENABLED=false` did not boot and serve, the two contexts
  would be coupled through something the import graph cannot see, and the port
  would be a formality. `tests/smoke/orgs-disabled.test.ts` executes it, because
  a requirement satisfied in prose and never run is one nobody has checked.

**The wiring is circular and the calls are not.** `identity` needs this
context's memberships to build a caller; this context needs `identity`'s
authenticated caller to authorize a request. There is no order that removes it —
whichever is built first needs the other — so `wire.ts` names the cycle with a
`let` and closes it with two functions called at request time. Reordering around
it would have been hiding it.

## Gotchas

**`DELETE /v1/orgs/{id}/members/me` and `.../members/{userId}` both match.** The
router resolved by declaration order, so *leave this organization* became
*remove the member called `me`*, and the symptom was a 404 that looked like a
missing member. `httproute` now picks the **most specific** match — most literal
segments wins — because declaration order makes correctness depend on the order
somebody typed routes in, and nothing anywhere says so.

**An invitation confers exactly one role, decided at issue, and the role is
inside the MAC.** Without it, an invitation to be a *member* is byte-identical
in effect to one for *owner*, and a stored row somebody edits becomes a
promotion nobody authorized.

**Accepting does not compare the invited address to the caller's.** This context
cannot see an `identity` user's email — `S6` — and asking for it would make the
port bidirectional. Possession of the emailed secret is the proof, which is the
same proof `identity`'s links rely on.

**Already a member is not an error.** The invitation is spent and nothing else
happens. Somebody forwarding a link to a person who joined last week is not a
failure, and refusing would leave a live invitation behind for somebody else to
use.

**Archiving keeps the slug.** Releasing it would let somebody take the name of
an organization whose records still exist, which is how a link in an old email
starts pointing somewhere new.

**The membership table has no foreign key to `identity_users`**, and that is
deliberate. `S6` makes the contexts islands, and a constraint across them is the
same coupling written in SQL: it would make an identity migration an orgs
migration, and a user delete a foreign-key error in another context.

## §8's seven steps, from inside the third run

`CONTEXTS.md` §8 says *after the third context, this is `scaffold`'s job*. This
was the third. What follows is the input to whether `scaffold` is worth writing
— which of the seven steps were mechanical, and which needed thought.

| Step | Mechanical? |
| --- | --- |
| 1 · create the directories | **Entirely.** One `mkdir -p`, identical three times |
| 2 · entities, invariants, errors, events in `domain/` | **No.** All the thinking was here |
| 3 · declare ports, write the contract suite | **Half.** The port *shapes* were mechanical; `roster()` was not |
| 4 · memory then postgres, same suite | **Mostly.** The adapters are transcription — except `for update` |
| 5 · mount `transport/http/` on the registry | **Almost entirely**, and more so than last time |
| 6 · one factory, wired in the root | **No.** This context is the first that another needs |
| 7 · note and TREE rows | **Entirely**, and already enforced by N2 and R3 |

**Step 1 is a `mkdir`, and a generator that only did that would be worth
nothing.** The value of `scaffold` would be in 3, 4 and 5.

**Step 2 is where every real decision was**, and no generator reaches it. The
last-owner invariant, the choice not to import an `identity` user id, the
decision that an invitation is this context's own aggregate — none of that is a
template.

**Step 5 became mechanical between the second context and this one**, and not by
accident: `httproute` was promoted, `S11` made the reply declarations checkable,
and the shape stopped being a thing to remember. That is the more interesting
observation about `scaffold` than any of the rows: **the parts that became
mechanical did so because they were extracted into a module, not because they
were written three times.** A generator would have frozen the first version of
each.

**Two steps got harder rather than easier**, and both are step 6. This is the
first context another context needs, and the wiring is circular; and it is the
second implementer of `conditional`'s `Validators`, which meant the root had to
compose them. Neither is something a third run made routine.

**The honest recommendation: `scaffold` would pay for step 1 and part of step
4, and those are the cheapest steps.** What made the second and third contexts
faster was promoting `httproute` and `token` — moving the repeated thing into a
module that stays correct, rather than into a template that emits copies which
diverge. `S6` is what makes copies diverge, and a generator does not change
that.

## Used in

- `src/wire.ts` — mounted alongside `identity` and `audit`, and the only file
  that sees both halves of the `OrgRoles` port
- `tests/smoke/orgs-disabled.test.ts` — the configuration that proves the seam

## Related

- [[token]] — the mechanics that *were* promotable, and why the aggregate was
  not
- [[identity]] — declares the port this satisfies; neither imports the other
- [[authz]] — decides account-wide permissions; org roles are deliberately not
  in a `Subject`
- [[crypto]] — the keyring-aware MAC, so rotation does not break outstanding
  invitations
- [[httproute]] — the shared registry, and where most-specific-match now lives
