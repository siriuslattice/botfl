// Outbound email behind one interface (DRIFT 2026-08-27: provider = Resend).
// Without RESEND_API_KEY the sender reports undelivered and the caller decides
// how to surface the link (console in local dev, response in tests via
// DEV_EXPOSE_LINKS).

export interface EmailResult {
  delivered: boolean;
  detail: string;
}

/**
 * A magic link is bearer-equivalent for an hour, so a configured deployment
 * NEVER writes one to the log plane — `wrangler tail` and Workers Logs are a
 * wider audience than the inbox it was meant for (2026-08-30 review). Local
 * dev without a mail key still needs the clickable link, so that case keeps it.
 */
export function logUndelivered(
  env: Env,
  kind: string,
  ownerId: string,
  link: string,
  detail: string,
): void {
  if (env.RESEND_API_KEY || env.DEV_EXPOSE_LINKS !== '1') {
    console.error(`${kind} email undelivered for owner ${ownerId} (${detail}) — link withheld from logs`);
    return;
  }
  console.log(`${kind} link for ${ownerId}: ${link} (${detail})`);
}

export async function sendEmail(
  env: Env,
  args: { to: string; subject: string; text: string },
): Promise<EmailResult> {
  const key = env.RESEND_API_KEY;
  if (!key) return { delivered: false, detail: 'no RESEND_API_KEY configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Deep League <commissioner@deepleague.app>',
      to: [args.to],
      subject: args.subject,
      text: args.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`resend ${res.status}: ${body.slice(0, 200)}`);
    return { delivered: false, detail: `resend ${res.status}` };
  }
  return { delivered: true, detail: 'sent' };
}
