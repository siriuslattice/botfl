// Outbound email behind one interface (DRIFT 2026-08-27: provider = Resend).
// Without RESEND_API_KEY the sender reports undelivered and the caller decides
// how to surface the link (console in prod-without-key, response in dev/tests
// via DEV_EXPOSE_LINKS).

export interface EmailResult {
  delivered: boolean;
  detail: string;
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
