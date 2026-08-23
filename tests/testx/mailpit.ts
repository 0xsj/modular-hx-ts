/**
 * Mailpit, for the `mailer` integration suite. **Test tooling.**
 *
 * The second service `testx` knows about, and it arrives as a **file beside
 * `postgres.ts`** rather than a redesign — which is what `../../MODULES.md` §3
 * asks of the harness: *Postgres now, Redis with `cache`, SMTP with `mailer`.*
 *
 * Reads messages back through Mailpit's HTTP API, because `send` returning
 * without throwing proves only that a server accepted bytes.
 */

export interface Delivered {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly to: readonly string[];
  readonly from: string;
}

function base(): string {
  // ../PORTS.md base 15420, Mailpit's web UI at offset +3.
  return process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:15423';
}

export function smtpHost(): { host: string; port: number } {
  return {
    host: process.env['SMTP_HOST'] ?? '127.0.0.1',
    // Offset +2.
    port: Number(process.env['SMTP_PORT'] ?? 15422),
  };
}

/** Is Mailpit answering? Used by the gate, so a missing service skips. */
export async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${base()}/readyz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteAll(): Promise<void> {
  await fetch(`${base()}/api/v1/messages`, { method: 'DELETE' });
}

interface Summary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { Address: string }[];
  readonly From: { Address: string };
}

/**
 * The most recent message to an address, with both rendered parts.
 *
 * Two calls, because Mailpit's list endpoint carries headers only — the parts
 * come from the per-message endpoint, and asserting on a summary would prove
 * the subject arrived and nothing else.
 */
export async function lastTo(email: string): Promise<Delivered | undefined> {
  const listed = await fetch(`${base()}/api/v1/messages?limit=50`);
  const { messages } = (await listed.json()) as { messages: Summary[] };

  const match = messages.find((m) =>
    m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()),
  );
  if (match === undefined) return undefined;

  const full = await fetch(`${base()}/api/v1/message/${match.ID}`);
  const body = (await full.json()) as { Text: string; HTML: string };

  return {
    subject: match.Subject,
    text: body.Text,
    html: body.HTML,
    to: match.To.map((t) => t.Address),
    from: match.From.Address,
  };
}

/** Every header on the most recent message — for the injection assertions. */
export async function rawHeaders(email: string): Promise<string> {
  const listed = await fetch(`${base()}/api/v1/messages?limit=50`);
  const { messages } = (await listed.json()) as { messages: Summary[] };
  const match = messages.find((m) =>
    m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()),
  );
  if (match === undefined) return '';

  const raw = await fetch(`${base()}/api/v1/message/${match.ID}/raw`);
  return raw.text();
}
