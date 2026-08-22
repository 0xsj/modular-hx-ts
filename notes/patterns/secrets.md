---
module: secrets
layer: L1
---

# Secrets

## What

Secret **references**, resolved before configuration is parsed
(`../ARCHITECTURE.md` §8). Two schemes:

```
SMTP_PASSWORD=file:///run/secrets/smtp#password
SMTP_PASSWORD=env://SMTP_PASSWORD_REAL
```

`resolving(source)` wraps an [[env]] `Source` and returns another one, plus
`problems()` for every reference it could not follow. Anything that is not a
reference passes through untouched.

## Why

### A credential should not be in the environment at all

An environment variable is visible in `/proc`, in a crash dump, in a `docker
inspect`, in a process listing, and in whatever CI printed while debugging. A
**reference** is not a credential: `file:///run/secrets/smtp#password` leaks
nothing when it appears in any of those, and the value it names is readable only
by a process that can read the file.

### It wraps a `Source`, which is why that port exists

`env` never learns anything happened. No schema changes, no reader knows about
references, and a test can swap the whole mechanism out by passing a different
source. That is the entire integration:

```ts
const secrets = resolving(fromProcess());
const config = load(secrets.source, SCHEMA);
```

`../INFRASTRUCTURE.md` §7.1 states the payoff plainly: a Kubernetes `Secret`
mounted as files **is** this reference, and needs *no new code*. That only holds
because a mount is a directory of one file per key, and the directory form is
tried before the file form.

### Problems are collected, not thrown

Throwing on a broken reference would abort before `env` had gathered the rest,
and one variable per restart is precisely the failure mode both modules exist to
avoid. A missing secret and a malformed port arrive together:

```
2 configuration problems
  DATABASE_URL  file:///run/secrets/absent: no such file or directory
  PORT          is not a whole number: 80a0
```

A failed reference **replaces** `is required` for the same variable, because
"no such file" is the useful half of that pair.

**Rejected: a secret-manager client.** Vault, Secrets Manager and the rest all
mount or inject into a file or a variable, which is the shape this already
speaks. A client would add a network dependency to the boot path — the one place
a process cannot retry its way out of trouble.

**Rejected: decrypting in-process.** A key to decrypt the secrets has to come
from somewhere, and that somewhere is a file or a variable. It moves the problem
rather than solving it.

### One escape, inside the value

Every variable is scanned, so a password that genuinely begins `env://` would be
unrepresentable — the syntax would have broken the thing it was protecting. A
`literal:` prefix is stripped and the remainder returned **verbatim**.

Verbatim is the load-bearing word. Unlike a reference the remainder is *not*
trimmed: a reference with surrounding whitespace is a typo, a password with a
trailing space is a password, and an escape that quietly edited the value it was
protecting would be worse than no escape at all.

The check sits inside `follow`, not at the entry point, so a value reached
through `env://` escapes exactly as a directly-set one does.

**Rejected: a per-variable annotation** — `SMTP_PASSWORD_IS_LITERAL=1`, or a
flag on the reader. It puts the escape in the schema, where the person writing
the `.env` file cannot reach it, and doubles the surface for the rare case.

### The check command exists to end the restart loop

`modular-hx-ts secrets` prints each reference, its source, and a will-it-boot
exit code, **without printing a value**.

Without it, a broken reference surfaces as a process that exits 78 with one
line; you fix that line, restart, and it exits 78 with the next — one variable
per restart, against a deployment that is already down. `env` already collects
every *parse* problem at once; this does the same for resolution, before the
process is asked to boot at all.

It needs no configuration, for the same reason `version` does not: a broken
reference is *why* configuration will not load, so a check that required
configuration would be unavailable exactly when it is wanted.

**It resolves through `resolving`, not beside it.** A check with its own copy of
the resolution path diagnoses a different program, and would agree with boot
right up until the moment it mattered — the Kubernetes directory-mount form
being the case most likely to differ. Rendering lives in the module rather than
in `main.ts`, because the guarantee that no value is printed is this module's to
keep and should not depend on every future caller remembering it.

## Example

```ts
// Composition root. The only change from reading the environment directly.
const secrets = resolving(fromProcess());
const config = load(secrets.source, SCHEMA);

// Both kinds of problem, in one report.
const problems = [...secrets.problems(), ...fieldsOf(config)];
```

```yaml
# Kubernetes: mount the Secret, reference a key.
volumeMounts: [{ name: smtp, mountPath: /run/secrets/smtp, readOnly: true }]
env:
  - { name: SMTP_PASSWORD, value: "file:///run/secrets/smtp#password" }
```

## Gotchas

- **`literal:` must be checked before `parse`.** Otherwise the parser sees the
  scheme inside the escaped value and treats the escape as a reference —
  the one ordering bug this design can have.
- **The check command must print nothing that came out of a file.** Its report
  carries variable names, reference targets and failure reasons, and a test
  asserts a known credential does not appear in either the rendered report or
  the inspection objects. A check that leaked the secret it was verifying would
  be worse than the restart loop it replaces.
- **Resolution is lazy, so `problems()` is only complete after `load`.**
  Resolving everything up front would read files for values this process never
  wants, and fail on a reference belonging to a feature that is switched off. A
  test that inspects `problems()` without reading anything sees an empty list —
  which is what happened the first time one did.
- **The trailing newline is stripped.** Every file ends with one and no
  credential contains one. `echo -n` is the usual advice and the usual thing
  forgotten, and a newline in a password produces an authentication failure that
  looks exactly like a wrong password.
- **A directory is tried before a file.** `file:///run/secrets/smtp#password` is
  `/run/secrets/smtp/password` when the path is a directory, and a key *inside*
  the file otherwise. The first is what Kubernetes produces; the second is what
  a `.env` or a JSON blob from a secret manager looks like.
- **Error messages carry the reference, never the contents.** A path is safe to
  report; what is in it never is, and an error about a secret is still a log
  line. There is a test asserting the value does not appear.
- **A chain is followed, but not forever.** `env://` may point at another
  reference; eight hops in, it is a loop or a mistake and either way the answer
  is to say so.
- **A file is capped at 1 MiB.** Pointing a reference at a log file should fail
  clearly rather than read a gigabyte into memory and fail somewhere less
  obvious.
- **The resolved value is still a plain string here.** [[env]]'s `sensitive()`
  is what wraps it in a [[redact]] `Secret`; this module only decides *where the
  bytes come from*.
- **Only these two prefixes are special.** A value that merely contains
  `file://` — a message, a URL in prose — is a literal. A password may begin
  with almost anything, so recognition is deliberately narrow.

## Used in

- `src/shared/secrets/index.ts`
- `src/shared/secrets/inspect.ts`
- `src/shared/secrets/reference.ts`
- `src/shared/secrets/filesystem.ts`
- `src/shared/secrets/resolve.ts`
- `src/main.ts`

## Related

[[env]] — the `Source` this wraps, and where a resolved secret becomes a
`Secret`. [[redact]] — what `sensitive()` wraps it in, so a resolved credential
still cannot print by accident. [[errors]] — problems share the shape `env`
reports, so configuration failures read identically whichever module found them.
