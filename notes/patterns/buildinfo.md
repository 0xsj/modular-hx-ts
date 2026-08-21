---
module: buildinfo
layer: L0
---

# Buildinfo

## What

What this binary is: name, version, commit, build time, and whether the working
tree was dirty. `buildInfo(raw)` normalizes whatever the build stamped in;
`describe` formats a startup log line, `userAgent` an outbound header, and
`versionPayload` the `/version` response.

## Why

The first question of every incident is **"what is actually deployed"**, and an
answer that requires reading a CI log is not an answer. It needs to be in the
startup line, in the health response, and in the `User-Agent` of every outbound
call — so that when a dependency asks which of your deploys is hammering them,
the answer is already in their logs.

### It reads no environment

`process.env` is process state, which is L1's concern (`env`), not L0's. The
composition root passes the values in from wherever the build put them.

That is not purity for its own sake. It means the formatting is testable without
a build, without a container, and without setting environment variables in a
test — and it means the same `BuildInfo` can be constructed from a generated
file, a set of variables, or a literal, without this module having an opinion.

### It fails open

Invariant I9, decided deliberately: this is an **observability** concern, so a
missing or malformed stamp degrades to `dev`/`unknown` rather than stopping the
process. Refusing to boot because a version string was wrong converts a cosmetic
defect into an outage — and it would happen during the rollback that was meant
to fix something else.

`unknown` is the honest answer. An empty string, or a literal `$COMMIT` that
never got substituted, is worse than admitting the value is missing, so both
become `unknown`.

**Rejected: reading `package.json` at runtime.** It answers the version and not
the commit, it needs a filesystem read from L0, and in a bundled or
single-executable build the file is not where the code thinks it is.

**Rejected: a generated `version.ts` committed to the repo.** It works, and it
makes every build dirty the working tree it is trying to describe. Passing the
values in at the root keeps the source stable.

## Example

```dockerfile
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILT_AT
ENV APP_VERSION=$VERSION APP_COMMIT=$COMMIT APP_BUILT_AT=$BUILT_AT
```

```ts
// Composition root — the one place allowed to read the environment.
const info = buildInfo({
  name: 'modular-hx-ts',
  version: env.APP_VERSION,
  commit: env.APP_COMMIT,
  builtAt: env.APP_BUILT_AT,
  dirty: env.APP_DIRTY,
});

logger.info(describe(info));           // modular-hx-ts 1.4.0 (a1b2c3d, built …)
httpClient.defaultHeaders['user-agent'] = userAgent(info);
routes.get('/version', () => versionPayload(info));
```

## Gotchas

- **An unsubstituted placeholder means the build template never ran.** `$COMMIT`
  or `${GIT_SHA}` arriving verbatim is a broken pipeline, and echoing it back
  hides that. It becomes `unknown`, which is a question somebody asks.
- **`dirty` is the field that explains the inexplicable.** When deployed
  behaviour does not match the commit somebody is reading, a dirty build is
  usually why. Stamp it from `git status --porcelain`, and treat it as an alarm
  in anything but a local build.
- **`versionPayload` is a public API shape.** It is not the whole `BuildInfo`,
  because a `Date` serializes differently depending on who does it. The ISO
  conversion happens once, here, and the payload survives a JSON round trip
  unchanged.
- **Decide whether `/version` is public.** Exposing a commit sha is normal and
  useful, and it does tell an attacker exactly which published vulnerabilities
  apply. That is a real trade and it should be a decision rather than a default:
  either it is open, or it sits behind the same authorization as the rest of the
  operational surface.
- **Never put anything else in here.** It is served publicly and printed into
  logs, which makes it the most attractive place in the codebase to stash "just
  one more" piece of configuration.

## Used in

- `src/shared/buildinfo/index.ts`
- `src/shared/buildinfo/index.test.ts`

This list grows to the composition root, the health endpoint, the startup log
line and `httpclient`'s default headers.

## Related

[[clock]] — a build stamp is a literal instant, not a reading of the clock,
which is why rule `M2` permits `new Date(value)` here and forbids `new Date()`.
[[errors]] and [[result]] are deliberately absent: nothing in this module can
fail, because failing would be worse than being vague.
