---
module: mailer
layer: L2
---

# Mailer

## What

`send(message) -> Receipt` behind a port, with three adapters and one contract
suite.

```
memory   records, and logs the link at debug
smtp     nodemailer against a real server (Mailpit at rung 2)
none     drops, and still validates
```

Templates are `<name>[.<lang>].{subject,txt,html}`, compiled at boot.

## Why

### The memory adapter is not a test double

The distinction is the whole reason it exists. It is what lets `STORAGE=memory`
run `identity`'s verification flow **with no Docker** — the same role the memory
event bus plays for invariant `I1`.

Somebody cloning this repository, running `make dev` and registering a user has
to be able to *finish*. That means the verification link must be **retrievable**,
so it is logged at debug and kept in a mailbox anything can read. A "mailer" that
silently discarded in development would make the headline flow of the blueprint
unfinishable on a fresh clone.

Debug rather than info, deliberately: this runs on every send, and a link at
info is a token sitting in a production log aggregator.

### Header injection is the one place a missing check is a vulnerability

SMTP headers are CRLF-separated. A display name or subject containing a carriage
return or line feed does not produce a *malformed* header — it produces an
**extra** one:

```
Ada<CR><LF>Bcc: attacker@example.com     a silent copy of every email
Hello<CR><LF>From: ceo@example.com       a forged sender
```

So every header-bound field — addresses, display names, subject, tag — is
**rejected** on any control character. Not escaped, not stripped.

Rejecting rather than sanitising matters: a stripped newline turns an attack into
a slightly odd display name nobody investigates, while a rejection is an
`Invalid` naming the field, at the boundary, where the caller can see what it
did. The error never echoes the offending value, because a rejected header ends
up in a log and echoing it would reproduce the injection there.

**Every adapter validates, including `none`.** An adapter that skipped the check
because it was going to discard the message anyway would let a bug through in
staging that only appears in production.

### Compiled at boot, so 3am is not the discovery

A malformed placeholder or a template missing a default part fails **startup**,
with everything wrong reported at once. The alternative is finding out at the
first password reset, from the user who most needed the mail to arrive.

`mailer` never reads the filesystem. Sources are handed in by the composition
root — embedded in the binary in a deployment, a literal in a test — because a
template read at send time puts an I/O failure in the path of every send.

### Locale fallback is per part

A missing `de.html` falls back to the default `html` **while a present
`de.subject` is still used**.

Falling back whole-template would mean one untranslated part silently discards
every translated one — which is how a German user receives an entirely English
email because somebody had not finished the HTML yet. Per part, the translation
that exists is the translation that is used.

HTML auto-escapes every interpolated value; text and subject do not. A
user-supplied display name in a welcome email is the obvious injection, and the
escaping happening automatically is what stops a template author having to
remember.

### `mailer` knows nothing about users, tokens or challenges

It takes a `Message`. The decision to send belongs to a context — and
specifically to an **event subscriber, not a command's transaction**:

- a slow SMTP server must not hold a database transaction open;
- a registration that rolls back must not already have sent a welcome email.

There is deliberately no `send(userId, template)` convenience and no transaction
parameter anywhere in this module. The shape is inconvenient to call mid-write,
so the temptation does not arise when `identity` lands.

### A failure says whether retrying could help

| Condition | Kind | Retryable |
| --- | --- | :-: |
| Validation | `Invalid` | no — it will never succeed |
| SMTP 5xx (bad recipient, refused relay) | `Invalid` | no |
| SMTP 4xx (transient rejection) | `Unavailable` | yes |
| Connection refused, DNS failure | `Unavailable` | yes |
| Socket timeout | `Timeout` | yes |

That distinction is the entire point: `isRetryable` is true for `Unavailable`
and `Timeout` and false for `Internal`, so collapsing everything into `Internal`
would make every mail outage look permanent to `retry` and `breaker`.

The error names **the host and the status, never the credential** — a send
failure is exactly the moment somebody pastes a log into a ticket. The password
is a `Secret`, exposed only at the one call that needs the bytes.

## Example

```ts
// The composition root compiles templates once, and fails startup if any is bad.
const templates = unwrap(compileTemplates(TEMPLATES));

// A subscriber, not a command — see above.
events.subscribe({
  name: 'welcome-mail',
  pattern: 'identity.user.registered',
  handle: async (env) => {
    const parts = unwrap(templates.render('welcome', env.payload.lang, {
      name: env.payload.display_name,
      link: verifyUrl(env.payload.token),
    }));
    await mailer.send({ to: [{ email: env.payload.email }], from, ...parts });
  },
});
```

## Gotchas

- **Validation rejects, it never sanitises.** See above; this is the security
  property and the reason the contract suite has five cases for it.
- **`send` rejects, it never throws synchronously.** The memory and `none`
  adapters are not `async`, so a bare `throw` would propagate synchronously while
  `smtp` rejects — and a caller writing `send(m).catch(...)` would work against
  one adapter and blow up against another. Caught while writing the module, and
  exactly the divergence one suite over three adapters exists to stop.
- **The SMTP half reads messages back out of Mailpit.** `send` returning without
  throwing proves only that a server accepted bytes, not that both parts arrived
  or that no extra header was written. There is a test asserting the injected
  message reached **nobody** — a sanitising implementation would pass the
  rejection cases and fail that one by delivering something mangled.
- **Always both parts.** A text-only message looks broken in a modern client; an
  HTML-only one is unreadable in a plain-text one and scores as spam.
- **A control character in a source file is its own hazard.** The `CONTROL`
  regex is written as escapes, not literal bytes — a literal one makes the file
  binary to every text tool, which this repository has already paid for once.
- **`no-control-regex` is disabled on exactly one line**, with the reason. The
  lint exists to catch a control character written into a pattern by accident;
  here the pattern is the check.

## Used in

- `src/shared/mailer/index.ts`
- `tests/testx/mailpit.ts`

This list grows to `identity` — verification, password reset, and challenge
mail — each sent from a subscriber.

## Related

[[events]] — where a send is triggered from, and why it is a subscriber rather
than a command. [[redact]] — `Secret` holds the SMTP password so it cannot reach
a log through any of the four stringification paths. [[errors]] — the `Kind`
mapping, and why `Unavailable` and `Internal` must not be collapsed. [[retry]]
and [[breaker]] — the consumers of that distinction. [[secrets]] —
`SMTP_PASSWORD=file:///run/secrets/smtp#password` needs no code in this module.
[[env]] — the schema that reads it.
