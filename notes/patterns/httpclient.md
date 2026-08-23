---
module: httpclient
layer: L2
---

# HTTP client

## What

The outbound mirror of `httpx`. One client over the platform's `fetch`:

```
send(request) -> Result<HttpResponse>
```

Per-attempt timeout · bounded retries of only what is safe to replay ·
`Retry-After` honoured · provenance forwarded · status → `Kind` · bodies capped ·
per-host circuit breaker.

## Why

### The timeout is per attempt, not a total

A 30-second budget spent as **three 10-second attempts** is a different thing
from one 30-second attempt. It gives three chances at a flapping upstream, and
it bounds how long any single socket may hold a worker.

A total budget sounds tidier and behaves worse: the last attempt starts with
whatever is left, which is usually not enough to succeed, so it fails for a
reason unrelated to the upstream.

### Retry only what is safe to retry

By method — the idempotent set — **or** because the caller supplied an
`Idempotency-Key`, which is the caller asserting the upstream will deduplicate
it. Only the caller can know that.

**A bare `POST` is never retried.** Replaying a charge because a response was
slow is worse than failing it: the caller can see a failure and decide, and
cannot see a duplicate until the customer does.

`PATCH` is deliberately absent from the safe set. It is not idempotent in
general, and treating it as such because it usually is in practice is exactly
the assumption that breaks on the endpoint that increments.

Retries are **`Kind`-aware**: `Unavailable`, `Timeout` and `Exhausted` retry;
`Invalid`, `Forbidden` and `NotFound` never do. Sending a wrong request again
cannot make it right.

### `Retry-After` wins over local backoff

A server that states how long to wait **knows something the client does not** —
how long the rate limit actually has left, or when the deploy finishes. Local
backoff is a guess competing with a fact.

It is capped, because a hostile or broken upstream naming a date next year must
not park a worker until then. Both forms are accepted: delta-seconds and an
HTTP-date, with a past date meaning *now*.

This is why `retry` grew a `delayFor` hook. It sits beside the existing
`retryable` override for the same reason: the policy is the caller's, and the
loop is not.

### The upstream body never reaches the message

```
upstream api.stripe.com returned 503        <- the error
<html>Traceback: /srv/... token=sk_live_…   <- never
```

That body is attacker-influenced on some paths and noise on all of them, and it
is how internal detail ends up in a log line somebody screenshots. The status
and the host are the entire message; the status also goes in `details`, where a
dashboard can group on it.

### Provenance goes on the wire, and the actor does not

Correlation and the **parent** request id as headers, plus `traceparent`, read
from the ambient carrier — `../PROVENANCE.md` §3 names `httpclient` as one of
three consumers permitted to read ambient, because it is an **observer rather
than a stamper**.

**The actor is opt-in.** Propagating *who* is acting to an arbitrary third party
is an information leak by default: the recipient learns your user identifiers
for free, and cannot verify the claim anyway, so it grants them nothing they
should act on. `forwardActor: true` per request, for an upstream you control.

### Bodies are capped

`response.text()` buffers whatever the upstream sends, so one reply can exhaust
memory. `Content-Length` is a **claim, not a limit** — the only bound is reading
the stream and stopping. The reader is then cancelled rather than left draining
a server that may never stop.

### The breaker: per host, and never on a 4xx

This is `breaker`'s first real caller. It had existed since the 21st and had
only ever been exercised by its own unit tests.

**Per host, never global.** One dead endpoint must not stop the others, and the
key is the host rather than the URL so the window measures a dependency rather
than a path.

**Only unreachable-or-5xx counts toward opening.** A 4xx means the endpoint is
**up and rejecting you** — opening on it removes a working dependency because
somebody typed a bad id, and a 404 storm from one broken caller would take the
upstream out for everybody. `429` is excluded with a sharper edge: being rate
limited is the upstream working correctly, and tripping on it converts a
throttle into an outage. Those failures are reported to the breaker as
successes and to the caller as failures.

**Rule `M13` applies here through `breaker`.** Durations come from the monotonic
reading, never wall time. Both `es` repos shipped a wall-clock breaker and fixed
it, and this is the module where a regression would actually bite: a one-second
NTP correction holding a circuit open for an hour is invisible until an upstream
is unreachable and stays that way.

### Two layers both have a circuit policy, and that hid a vacuous test

`breaker` has its own `countsAsFailure`, defaulting to `isRetryable` —
`Unavailable` and `Timeout`. `httpclient` has `countsAgainstCircuit`, which is
the same set for its own reasons.

They agree, which is correct and was very nearly invisible: the test asserting
*a 404 does not open the circuit* passed with `countsAgainstCircuit` inverted to
count everything, because the breaker's default was still excluding a `NotFound`
one layer down. The module's own policy was never being exercised.

The fix is in the test rather than the code: it injects a breaker that counts
**everything**, which isolates the decision this module is responsible for. Two
layers holding the same policy is fine; a test that cannot tell which one is
enforcing it is not.

### Retries and the breaker cooperate

An **open circuit fails immediately without consuming a retry** — retrying
against a breaker that is refusing precisely to stop the traffic is the opposite
of what opening it was for. That needed a structural marker: the breaker's
rejection is `Unavailable`, which `isRetryable` reports true for, so without
`details.circuit` a retry loop would burn every attempt against it.

The breaker sits **inside** the attempt, so a retry that fails feeds the window
like any other failure.

## Example

```ts
const client = makeClient({ clock, retry, breaker, timeout: seconds(5) });

// Retried: idempotent by method.
const user = await client.send({ method: 'GET', url: `${api}/users/${id}` });

// Not retried: a bare POST.
const charge = await client.send({ method: 'POST', url: `${api}/charges`, body });

// Retried, because the caller asserts the upstream deduplicates.
const safe = await client.send({
  method: 'POST',
  url: `${api}/charges`,
  headers: { 'Idempotency-Key': idempotencyKey },
  body,
});
```

## Gotchas

- **`Exhausted` is retryable here and not in `errors.isRetryable`.** That
  function is about whether a failure is transient in general; this is about
  whether sending the same request again could succeed. A 429 is exactly what a
  `Retry-After` tells you to wait out.
- **`429` is `Exhausted`, not `Unavailable`.** It is the honest kind, and it
  keeps rate limiting distinguishable from an outage in a dashboard grouping by
  `err_kind`.
- **`Response.body` is typed `ReadableStream<any>`**, so the capped read is
  unchecked unless the element type is named. That is the difference between a
  bounded read and one the compiler cannot see.
- **The breaker's key is the host, including the port.** `api:443` and
  `api:8443` are different dependencies, and treating them as one would hide
  which is failing.
- **A 4xx is a success to the breaker and a failure to the caller.** That
  asymmetry looks wrong in the code until you remember what a circuit is for.
- **A test that counts requests cannot prove a circuit stayed closed.** An open
  circuit refuses *without calling*, so the request count is identical either
  way. Assert the breaker's own `snapshot`. Two of these tests were written the
  wrong way first and passed against a deliberately broken implementation.
- **A test that counts requests cannot prove a retry was not consumed either**,
  for the same reason. Count the **waits**: a retry that is consumed sleeps
  first, and one that is refused does not.
- **Tested against a real server, not a mocked `fetch`.** A stubbed client
  asserts what the code asked for; a server asserts what actually went on the
  wire — which headers arrived, how many requests were made, and whether a body
  that was never meant to be read was read anyway.

## Used in

- `src/shared/httpclient/index.ts`

This list grows to `webhooks` (outbound delivery with its own retry budget) and
to any context calling a third party.

## Related

[[breaker]] — its first real caller, and the `details.circuit` marker this
needed. [[retry]] — the `delayFor` hook that `Retry-After` required.
[[provenance]] — read ambient, because this is an observer; and why the actor
stays behind. [[errors]] — status to `Kind`, and why `Exhausted` is separate
from `Unavailable`. [[clock]] — monotonic, which is what keeps `M13` true
through the breaker. [[redact]] — the reason the upstream body never reaches a
message.
