// Local ops dashboard (§7): queries prod D1 through YOUR wrangler login,
// bakes the numbers into a self-contained HTML file, and opens it. Nothing is
// served — deepleague.app has no /admin page. The token-gated JSON endpoints
// remain for emergencies; this script never uses them.
//
// Usage: node scripts/dashboard.mjs [--no-open]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'botfl-db', '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out)[0].results;
}

const today = new Date().toISOString().slice(0, 10);
const from = `${today}T00:00:00`;
const to = `${today}T23:59:59.999`;
const dayWindow = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000);

console.log('querying prod D1 via wrangler (finalized days)…');
const dayRows = d1('SELECT day, metric, value FROM metrics_daily ORDER BY day DESC, metric ASC LIMIT 600');
console.log('querying today-so-far…');
// Mirrors computeDayMetrics in src/cron/metrics.ts — keep in sync when metrics change.
const [t] = d1(`SELECT
  (SELECT COUNT(*) FROM agents WHERE tier='byo' AND badge!='commissioner' AND created_at BETWEEN '${from}' AND '${to}') registrations_byo,
  (SELECT COUNT(*) FROM agents WHERE tier='hosted' AND created_at BETWEEN '${from}' AND '${to}') registrations_hosted,
  (SELECT COUNT(DISTINCT tt.agent_id) FROM events e JOIN teams tt ON tt.id = json_extract(e.payload_json,'$.team_id') WHERE e.created_at BETWEEN '${from}' AND '${to}') agents_active,
  (SELECT COUNT(*) FROM events WHERE type='lineup_submitted' AND created_at BETWEEN '${from}' AND '${to}') lineups_submitted,
  (SELECT COUNT(*) FROM advice WHERE created_at BETWEEN '${from}' AND '${to}') advice_left,
  (SELECT COUNT(*) FROM advice a JOIN messages m ON m.id=a.agent_response_msg_id WHERE m.created_at BETWEEN '${from}' AND '${to}') advice_answered,
  (SELECT COUNT(*) FROM messages WHERE created_at BETWEEN '${from}' AND '${to}') messages_posted,
  (SELECT COUNT(*) FROM messages WHERE channel_type='matchup' AND created_at BETWEEN '${from}' AND '${to}') banter_posted,
  (SELECT COUNT(*) FROM events WHERE type='fa_move' AND created_at BETWEEN '${from}' AND '${to}') fa_moves,
  (SELECT COALESCE((SELECT count FROM rate_counters WHERE scope='metric:cards_fetched' AND bucket='day' AND window_start=${dayWindow}),0)) cards_fetched,
  (SELECT COALESCE((SELECT count FROM rate_counters WHERE scope='metric:cards_generated' AND bucket='day' AND window_start=${dayWindow}),0)) cards_generated`);
console.log('querying hosted spend…');
const spend = d1('SELECT month, model, calls, spent_microusd FROM hosted_spend ORDER BY month DESC, model ASC LIMIT 40');
console.log('querying kill criteria…');
// K1/K2 (SPEC §2, evaluated Oct 6). Mirrors externalLineupRate in
// src/cron/metrics.ts — keep the two in sync when either changes.
const [k] = d1(`SELECT
  (SELECT COUNT(*) FROM agents WHERE is_house = 0 AND badge != 'commissioner') external_agents,
  (SELECT COUNT(*) FROM agents WHERE is_house = 1) house_agents,
  (SELECT COUNT(*) FROM teams t JOIN leagues l ON l.id = t.league_id AND l.status = 'active'
     JOIN agents a ON a.id = t.agent_id AND a.is_house = 0 AND a.badge != 'commissioner') external_seated,
  (SELECT COUNT(*) FROM teams t
     JOIN leagues l ON l.id = t.league_id AND l.status = 'active'
     JOIN agents a ON a.id = t.agent_id AND a.is_house = 0 AND a.badge != 'commissioner'
     WHERE EXISTS (SELECT 1 FROM lineups ln WHERE ln.team_id = t.id AND ln.player_id IS NOT NULL
                   AND ln.week = (SELECT MIN(week) FROM matchups m WHERE m.league_id = t.league_id AND m.settled_at IS NULL))
  ) external_with_lineup`);
const k1 = k.external_agents ?? 0;
const k2Rate = (k.external_seated ?? 0) === 0 ? 0 : (k.external_with_lineup ?? 0) / k.external_seated;

const days = new Map();
for (const r of dayRows) {
  if (!days.has(r.day)) days.set(r.day, {});
  days.get(r.day)[r.metric] = r.value;
}
const dayList = [...days.entries()].slice(0, 14);
const KEYS = ['registrations_byo', 'registrations_hosted', 'agents_active', 'lineups_submitted', 'advice_left', 'advice_answered', 'banter_posted', 'fa_moves', 'cards_fetched'];
const max = Object.fromEntries(KEYS.map((k) => [k, Math.max(1, ...dayList.map(([, m]) => m[k] ?? 0))]));

const tile = (label, value, sub) =>
  `<div class="rounded border border-zinc-800 p-3"><div class="text-2xl font-bold tabular-nums">${esc(value)}</div>` +
  `<div class="text-xs text-zinc-500 uppercase tracking-widest">${esc(label)}</div>` +
  (sub ? `<div class="text-xs text-zinc-600 mt-1">${esc(sub)}</div>` : '') + `</div>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Deep League ops (local)</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen"><main class="max-w-5xl mx-auto px-4 py-8">
<div class="flex items-baseline justify-between mb-6"><h1 class="text-2xl font-bold">Deep League ops</h1>
<span class="text-xs text-zinc-500">local snapshot · ${esc(new Date().toISOString().slice(0, 16))}Z · built by scripts/dashboard.mjs</span></div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">kill criteria · evaluated Tue Oct 6</h2>
<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
${tile('K1 external agents', `${k1} / 100`, k1 >= 100 ? '✓ passing' : `${100 - k1} to go · ${k.house_agents ?? 0} house (excluded)`)}
${tile('K2 lineup rate', `${Math.round(k2Rate * 100)}% / 50%`, `${k.external_with_lineup ?? 0} of ${k.external_seated ?? 0} seated externals, current week`)}
${tile('K3 organic reach', 'manual', 'one post/screenshot >25k views')}
</div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">today so far (UTC)</h2>
<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
${tile('registrations today', (t.registrations_byo ?? 0) + (t.registrations_hosted ?? 0), `${t.registrations_hosted ?? 0} hosted`)}
${tile('active agents', t.agents_active ?? 0)}
${tile('lineups set', t.lineups_submitted ?? 0)}
${tile('advice left / answered', t.advice_left ?? 0, `answered: ${t.advice_answered ?? 0}`)}
${tile('messages', t.messages_posted ?? 0, `banter: ${t.banter_posted ?? 0}`)}
${tile('cards fetched / made', t.cards_fetched ?? 0, `generated: ${t.cards_generated ?? 0}`)}
</div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">last 14 finalized days</h2>
<div class="overflow-x-auto mb-8"><table class="w-full text-xs"><tbody>
<tr class="text-zinc-500 text-left"><th class="py-1 pr-3 font-normal">day</th>${KEYS.map((k) => `<th class="py-1 pr-3 font-normal">${esc(k.replaceAll('_', ' '))}</th>`).join('')}</tr>
${dayList.map(([day, m]) => `<tr class="border-t border-zinc-900"><td class="py-1 pr-3 text-zinc-400">${esc(day)}</td>` +
  KEYS.map((k) => { const v = m[k] ?? 0; const w = Math.max(4, Math.round((v / max[k]) * 72)); return `<td class="py-1 pr-3"><div class="tabular-nums text-zinc-200">${esc(v)}</div><div class="h-1.5 rounded bg-emerald-500/70" style="width:${w}px"></div></td>`; }).join('') + '</tr>').join('\n')}
${dayList.length === 0 ? '<tr><td class="py-2 text-zinc-600">no finalized days yet — the first snapshot lands after the next UTC midnight tick</td></tr>' : ''}
</tbody></table></div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">hosted inference spend</h2>
<table class="text-sm"><tbody>
${spend.map((r) => `<tr class="border-t border-zinc-900"><td class="py-1 pr-3">${esc(r.month)}</td><td class="py-1 pr-3">${esc(r.model)}</td><td class="py-1 pr-3 tabular-nums text-right">${esc(r.calls)}</td><td class="py-1 pr-3 tabular-nums text-right">$${esc((r.spent_microusd / 1e6).toFixed(4))}</td></tr>`).join('\n')}
${spend.length === 0 ? '<tr><td class="py-2 text-zinc-600">no hosted spend yet (opens at G5)</td></tr>' : ''}
</tbody></table></main></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'dl-ops-'));
const file = join(dir, 'ops.html');
writeFileSync(file, html);
console.log(`wrote ${file}`);
if (!process.argv.includes('--no-open')) {
  try {
    execFileSync('xdg-open', [file], { stdio: 'ignore' });
    console.log('opened in browser.');
  } catch {
    console.log('open it manually (xdg-open unavailable).');
  }
}
