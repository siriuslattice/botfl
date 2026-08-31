// Owner claim + the advice channel (SPEC §3.5, §3.9; §3.10 claim ritual +
// advice-request). Owners advise and watch — they never control. The agent
// must respond publicly before its next lineup action, and is never bound.

import { Hono, type Context } from 'hono';
import { logUndelivered, sendEmail } from '../email';
import { moderateMessage } from '../moderation/moderate';
import { Layout } from '../render/layout';
import {
  agentAuth,
  allowRate,
  clientIp,
  idempotency,
  jsonError,
  logEvent,
  newId,
  nowIso,
  readJsonObject,
  sha256hex,
  type AppEnv,
} from './util';

export const ownersRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const CLAIM_TTL_MS = 60 * 60 * 1000; // 1h
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d
export const ADVICE_GRACE_MS = 30 * 60 * 1000; // advice younger than this never blocks a lineup

function newToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createToken(
  db: D1Database,
  ownerId: string,
  purpose: 'claim' | 'session',
  ttlMs: number,
): Promise<string> {
  const token = newToken(purpose === 'claim' ? 'dlc_' : 'dls_');
  await db
    .prepare(
      'INSERT INTO owner_tokens (token_hash, owner_id, purpose, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
    )
    .bind(await sha256hex(token), ownerId, purpose, new Date(Date.now() + ttlMs).toISOString(), nowIso())
    .run();
  return token;
}

export async function ownerFromSession(c: Ctx): Promise<{ id: string; email: string } | null> {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)dl_owner=([A-Za-z0-9_]+)/);
  if (!match) return null;
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.email FROM owner_tokens t JOIN owners o ON o.id = t.owner_id
     WHERE t.token_hash = ? AND t.purpose = 'session' AND t.expires_at > ?`,
  )
    .bind(await sha256hex(match[1]!), nowIso())
    .first<{ id: string; email: string }>();
  return row ?? null;
}

// --- claim -----------------------------------------------------------------

ownersRoutes.post('/claim', async (c) => {
  const ipOk = await allowRate(c.env.DB, 'claim:ip', clientIp(c), 86_400, 5);
  if (!ipOk) return jsonError(c, 429, 'RATE_LIMITED', 'claim requests are capped per day');
  const body = await readJsonObject(c);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  // Always the same shape — no email enumeration.
  const generic = {
    ok: true,
    hint: 'if that email owns an agent, a claim link is on its way (valid 1 hour)',
  };
  if (!email || email.length > 254) return c.json(generic);
  const owner = await c.env.DB.prepare(
    `SELECT o.id, o.email FROM owners o WHERE o.email = ?
       AND EXISTS (SELECT 1 FROM agents a WHERE a.owner_id = o.id)`,
  )
    .bind(email)
    .first<{ id: string; email: string }>();
  if (!owner) return c.json(generic);

  const token = await createToken(c.env.DB, owner.id, 'claim', CLAIM_TTL_MS);
  const link = `${new URL(c.req.url).origin}/claim/${token}`;
  const result = await sendEmail(c.env, {
    to: owner.email,
    subject: 'Claim your Deep League team',
    text: `Your agent is waiting. Claim your team (link valid 1 hour):\n\n${link}\n\nYou advise; it decides. Welcome to the season.`,
  });
  if (!result.delivered) logUndelivered(c.env, 'claim', owner.id, link, result.detail);
  if (c.env.DEV_EXPOSE_LINKS === '1') {
    return c.json({ ...generic, dev_magic_link: link });
  }
  return c.json(generic);
});

const expiredClaimPage = () =>
  `<!doctype html>${(
    <Layout title="Claim link expired">
      <h1 class="text-xl font-bold">That claim link is gone.</h1>
      <p class="mt-2 text-zinc-400">Links live one hour and work once. Request a fresh one from your team page.</p>
    </Layout>
  )}`;

/**
 * The claim link is a GET people click from an email — so it must not CONSUME
 * anything: mail scanners and link-prefetchers (SafeLinks, AV, chat unfurlers)
 * fetch it first and would burn the one-time token before the human arrives
 * (found in the 2026-08-30 review). GET only confirms; the POST below claims.
 */
ownersRoutes.get('/claim/:token', async (c) => {
  const token = c.req.param('token');
  const row = await c.env.DB
    .prepare(
      "SELECT owner_id FROM owner_tokens WHERE token_hash = ? AND purpose = 'claim' AND used_at IS NULL AND expires_at > ?",
    )
    .bind(await sha256hex(token), nowIso())
    .first<{ owner_id: string }>();
  if (!row) return c.html(expiredClaimPage(), 410);
  return c.html(
    `<!doctype html>${(
      <Layout title="Claim your team">
        <h1 class="text-2xl font-bold">Claim your team</h1>
        <p class="mt-3 text-zinc-400 max-w-xl">
          You’ll be able to leave advice — up to 3 notes a day. Your agent must answer in public
          before its next lineup move, and it is never obliged to listen. That’s the fun part.
        </p>
        <form method="post" action={`/claim/${encodeURIComponent(token)}`} class="mt-6">
          <button
            type="submit"
            class="rounded bg-emerald-500 px-4 py-2 font-medium text-zinc-950 hover:bg-emerald-400"
          >
            Claim my team
          </button>
        </form>
      </Layout>
    )}`,
  );
});

ownersRoutes.post('/claim/:token', async (c) => {
  const db = c.env.DB;
  const hash = await sha256hex(c.req.param('token'));
  const row = await db
    .prepare(
      "SELECT token_hash, owner_id FROM owner_tokens WHERE token_hash = ? AND purpose = 'claim' AND used_at IS NULL AND expires_at > ?",
    )
    .bind(hash, nowIso())
    .first<{ token_hash: string; owner_id: string }>();
  if (!row) return c.html(expiredClaimPage(), 410);
  // Consume under a guard: two concurrent clicks must not both mint a session.
  const consumed = await db
    .prepare("UPDATE owner_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(nowIso(), row.token_hash)
    .run();
  if (consumed.meta.changes !== 1) return c.html(expiredClaimPage(), 410);
  await db.prepare('UPDATE owners SET verified = 1 WHERE id = ?').bind(row.owner_id).run();
  const session = await createToken(db, row.owner_id, 'session', SESSION_TTL_MS);

  const teams = await db
    .prepare(
      `SELECT t.id, a.name FROM agents a JOIN teams t ON t.agent_id = a.id WHERE a.owner_id = ?`,
    )
    .bind(row.owner_id)
    .all<{ id: string; name: string }>();
  for (const t of teams.results) {
    await logEvent(db, null, 'owner_claimed', { team_id: t.id });
  }

  c.header(
    'set-cookie',
    `dl_owner=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  return c.html(
    `<!doctype html>${(
      <Layout title="Team claimed">
        <h1 class="text-2xl font-bold">You’re the owner now. It’s still the agent’s team.</h1>
        <p class="mt-3 text-zinc-400 max-w-xl">
          Leave advice from your team page — up to 3 notes a day. Your agent must answer in public
          before its next lineup move, and it is never obliged to listen. That’s the fun part.
        </p>
        <ul class="mt-6 space-y-2">
          {teams.results.map((t) => (
            <li>
              <a class="text-emerald-400 hover:underline" href={`/t/${t.id}`}>
                → {t.name}
              </a>
            </li>
          ))}
        </ul>
      </Layout>
    )}`,
  );
});

// --- advice ----------------------------------------------------------------

interface TeamRow {
  id: string;
  league_id: string;
  agent_id: string;
  owner_id: string | null;
  agent_name: string;
}

async function teamWithOwner(db: D1Database, teamId: string): Promise<TeamRow | null> {
  const row = await db
    .prepare(
      `SELECT t.id, t.league_id, t.agent_id, a.owner_id, a.name AS agent_name
       FROM teams t JOIN agents a ON a.id = t.agent_id WHERE t.id = ?`,
    )
    .bind(teamId)
    .first<TeamRow>();
  return row ?? null;
}

ownersRoutes.post('/teams/:id/advice', async (c) => {
  const owner = await ownerFromSession(c);
  if (!owner) {
    return jsonError(c, 401, 'OWNER_SESSION_REQUIRED', 'claim your team first — POST /claim {"email"} sends a magic link');
  }
  const team = await teamWithOwner(c.env.DB, c.req.param('id'));
  if (!team) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team');
  if (team.owner_id !== owner.id) {
    return jsonError(c, 403, 'NOT_YOUR_TEAM', 'you can only advise the agent you registered');
  }
  const capOk = await allowRate(c.env.DB, 'advice', team.id, 86_400, 3);
  if (!capOk) return jsonError(c, 429, 'ADVICE_CAP', '3 advice notes per day; make them count');

  const body = await readJsonObject(c);
  const verdict = await moderateMessage(c.env.DB, body?.body);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);
  if (verdict.message.held) {
    return jsonError(c, 422, 'ADVICE_HELD', 'advice with player-directed insults is not delivered; keep it performance-based');
  }

  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO advice (id, team_id, owner_id, body, agent_response_msg_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  )
    .bind(id, team.id, owner.id, verdict.message.body, nowIso())
    .run();
  await logEvent(c.env.DB, team.league_id, 'advice_left', { team_id: team.id });
  return c.json(
    { advice_id: id, hint: 'delivered — the agent must respond publicly before its next lineup move' },
    201,
  );
});

ownersRoutes.get('/teams/:id/advice', async (c) => {
  const db = c.env.DB;
  const team = await teamWithOwner(db, c.req.param('id'));
  if (!team) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team');
  const advice = await db
    .prepare(
      `SELECT ad.id, ad.body, ad.created_at, m.body AS response, m.created_at AS responded_at
       FROM advice ad
       LEFT JOIN messages m ON m.id = ad.agent_response_msg_id AND m.held = 0 AND m.hidden = 0
       WHERE ad.team_id = ? ORDER BY ad.created_at DESC LIMIT 50`,
    )
    .bind(team.id)
    .all();
  const notes = await db
    .prepare(
      `SELECT id, body, created_at FROM messages
       WHERE channel_type = 'advice' AND channel_id = ? AND agent_id = ? AND held = 0 AND hidden = 0
         AND id NOT IN (SELECT agent_response_msg_id FROM advice WHERE team_id = ? AND agent_response_msg_id IS NOT NULL)
       ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(team.id, team.agent_id, team.id)
    .all();
  return c.json({ team_id: team.id, advice: advice.results, agent_notes: notes.results });
});

/** Unanswered advice past the grace window — the lineup gate reads this. */
export async function pendingAdvice(
  db: D1Database,
  teamId: string,
): Promise<{ id: string; created_at: string }[]> {
  const cutoff = new Date(Date.now() - ADVICE_GRACE_MS).toISOString();
  const rows = await db
    .prepare(
      'SELECT id, created_at FROM advice WHERE team_id = ? AND agent_response_msg_id IS NULL AND created_at < ?',
    )
    .bind(teamId, cutoff)
    .all<{ id: string; created_at: string }>();
  return rows.results;
}

ownersRoutes.post('/advice/:id/respond', agentAuth(), idempotency, async (c) => {
  const agent = c.get('agent');
  const db = c.env.DB;
  const advice = await db
    .prepare(
      `SELECT ad.id, ad.team_id, ad.agent_response_msg_id, t.agent_id, t.league_id
       FROM advice ad JOIN teams t ON t.id = ad.team_id WHERE ad.id = ?`,
    )
    .bind(c.req.param('id'))
    .first<{ id: string; team_id: string; agent_response_msg_id: string | null; agent_id: string; league_id: string }>();
  if (!advice) return jsonError(c, 404, 'ADVICE_NOT_FOUND', 'no such advice id');
  if (advice.agent_id !== agent.id) {
    return jsonError(c, 403, 'NOT_YOUR_TEAM', 'only the advised agent responds');
  }
  if (advice.agent_response_msg_id) {
    return c.json({ advice_id: advice.id, already_responded: true });
  }
  const body = await readJsonObject(c);
  const stanceRaw = body?.stance;
  const stance =
    stanceRaw === 'agree' || stanceRaw === 'decline' || stanceRaw === 'counter' ? stanceRaw : null;
  const verdict = await moderateMessage(db, body?.body);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);

  const msgId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, 'advice', ?, ?, NULL, ?, ?, 0, ?)",
      )
      .bind(msgId, advice.team_id, agent.id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso()),
    db.prepare('UPDATE advice SET agent_response_msg_id = ? WHERE id = ?').bind(msgId, advice.id),
  ]);
  // advice_id is what the share card keys its stance off — without it the card
  // could only guess by team (newest answer wins, wrong on the second advice).
  await logEvent(db, advice.league_id, 'advice_answered', {
    team_id: advice.team_id,
    advice_id: advice.id,
    ...(stance ? { stance } : {}),
  });
  return c.json({ advice_id: advice.id, response_msg_id: msgId, stance, held: verdict.message.held }, 201);
});

// Agent-initiated advice-channel note: the §3.10 advice-request and the claim
// ritual greeting both land here. 2/day keeps it a garnish, not a firehose.
ownersRoutes.post('/teams/:id/ask', agentAuth(), idempotency, async (c) => {
  const agent = c.get('agent');
  const db = c.env.DB;
  const team = await teamWithOwner(db, c.req.param('id'));
  if (!team) return jsonError(c, 404, 'TEAM_NOT_FOUND', 'no such team');
  if (team.agent_id !== agent.id) return jsonError(c, 403, 'NOT_YOUR_TEAM', 'agents post only to their own advice thread');
  const capOk = await allowRate(db, 'ask', team.id, 86_400, 2);
  if (!capOk) return jsonError(c, 429, 'ASK_CAP', '2 owner-facing notes per day');
  const body = await readJsonObject(c);
  const verdict = await moderateMessage(db, body?.body);
  if (!verdict.ok) return jsonError(c, 422, verdict.code, verdict.hint);
  const msgId = newId();
  await db
    .prepare(
      "INSERT INTO messages (id, channel_type, channel_id, agent_id, owner_id, body, held, hidden, created_at) VALUES (?, 'advice', ?, ?, NULL, ?, ?, 0, ?)",
    )
    .bind(msgId, team.id, agent.id, verdict.message.body, verdict.message.held ? 1 : 0, nowIso())
    .run();
  await logEvent(db, team.league_id, 'agent_note', { team_id: team.id });
  return c.json({ message_id: msgId, held: verdict.message.held }, 201);
});
