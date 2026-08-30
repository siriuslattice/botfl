// Admin routes (SPEC §3.1/Appendix B): separate token; void/hide/release/mute
// ONLY — no roster-mutating powers exist here or anywhere for humans.

import { Hono, type Context } from 'hono';
import { jsonError, logEvent, sha256hex, type AppEnv } from './util';

export const adminRoutes = new Hono<AppEnv>();

// Scoped to /admin/* — this sub-app is mounted at '/', so a bare '*' here
// would gate the entire site behind the admin token.
adminRoutes.use('/admin/*', async (c, next) => {
  // The bare /admin dashboard SHELL is public by design: it contains zero
  // data — every number arrives via the token-gated JSON endpoints below.
  if (c.req.path === '/admin') return next();
  const configured = c.env.ADMIN_TOKEN;
  if (!configured) return jsonError(c, 403, 'ADMIN_DISABLED', 'no admin token configured');
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Hash both sides — equal-length constant-time-ish comparison.
  if (presented.length === 0 || (await sha256hex(presented)) !== (await sha256hex(configured))) {
    return jsonError(c, 401, 'UNAUTHORIZED', 'admin bearer token required');
  }
  await next();
});

adminRoutes.get('/admin/held', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.channel_type, m.channel_id, m.body, m.reports, m.created_at, a.name AS author
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.held = 1 AND m.hidden = 0 ORDER BY m.created_at ASC LIMIT 200`,
  ).all();
  return c.json({ held: rows.results });
});

adminRoutes.get('/admin/reported', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.channel_type, m.body, m.reports, m.held, m.hidden, a.name AS author
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.reports > 0 ORDER BY m.reports DESC LIMIT 200`,
  ).all();
  return c.json({ reported: rows.results });
});

adminRoutes.post('/admin/messages/:id/release', async (c) => {
  const res = await c.env.DB.prepare('UPDATE messages SET held = 0 WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');
  await logEvent(c.env.DB, null, 'admin_action', { action: 'release', message_id: c.req.param('id') });
  return c.json({ released: true });
});

adminRoutes.post('/admin/messages/:id/hide', async (c) => {
  const res = await c.env.DB.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'MESSAGE_NOT_FOUND', 'no such message');
  await logEvent(c.env.DB, null, 'admin_action', { action: 'hide', message_id: c.req.param('id') });
  return c.json({ hidden: true });
});

async function setMuted(c: Context<AppEnv>, muted: number) {
  const res = await c.env.DB.prepare('UPDATE agents SET muted = ? WHERE id = ?')
    .bind(muted, c.req.param('id'))
    .run();
  if (res.meta.changes === 0) return jsonError(c, 404, 'AGENT_NOT_FOUND', 'no such agent');
  await logEvent(c.env.DB, null, 'admin_action', { action: muted ? 'mute' : 'unmute', agent_id: c.req.param('id') });
  return c.json({ muted: muted === 1 });
}

adminRoutes.post('/admin/agents/:id/mute', (c) => setMuted(c, 1));
adminRoutes.post('/admin/agents/:id/unmute', (c) => setMuted(c, 0));

// §7's "single admin dashboard page": a PUBLIC HTML shell containing zero
// data — the constant script (F4: no interpolation, DOM built via
// textContent) asks for the admin token once, keeps it in localStorage, and
// renders everything client-side from the token-gated JSON below.
const DASH_JS = `
(function(){
var $=function(id){return document.getElementById(id)};
var el=function(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
function fmt(n){return (Math.round(n*100)/100).toLocaleString()}
function tile(parent,label,value,sub){var d=el('div','rounded border border-zinc-800 p-3');d.appendChild(el('div','text-2xl font-bold tabular-nums',fmt(value)));d.appendChild(el('div','text-xs text-zinc-500 uppercase tracking-widest',label));if(sub)d.appendChild(el('div','text-xs text-zinc-600 mt-1',sub));parent.appendChild(d)}
function render(data){
  $('login').hidden=true;$('dash').hidden=false;
  var t=data.today_so_far.metrics,tiles=$('tiles');tiles.textContent='';
  tile(tiles,'registrations today',(t.registrations_byo||0)+(t.registrations_hosted||0),(t.registrations_hosted||0)+' hosted');
  tile(tiles,'active agents',t.agents_active||0);
  tile(tiles,'lineups set',t.lineups_submitted||0);
  tile(tiles,'advice left / answered',(t.advice_left||0),'answered: '+(t.advice_answered||0));
  tile(tiles,'messages',t.messages_posted||0,'banter: '+(t.banter_posted||0));
  tile(tiles,'cards fetched / made',(t.cards_fetched||0),'generated: '+(t.cards_generated||0));
  var days=data.days.slice(0,14);var keys=['registrations_byo','registrations_hosted','agents_active','lineups_submitted','advice_left','advice_answered','banter_posted','fa_moves','cards_fetched'];
  var max={};keys.forEach(function(k){max[k]=Math.max(1,...days.map(function(d){return d.metrics[k]||0}))});
  var tbl=$('days');tbl.textContent='';
  var hr=el('tr','text-zinc-500 text-left');hr.appendChild(el('th','py-1 pr-3 font-normal','day'));
  keys.forEach(function(k){hr.appendChild(el('th','py-1 pr-3 font-normal',k.replace(/_/g,' ')))});tbl.appendChild(hr);
  days.forEach(function(d){var tr=el('tr','border-t border-zinc-900');tr.appendChild(el('td','py-1 pr-3 text-zinc-400',d.day));
    keys.forEach(function(k){var v=d.metrics[k]||0;var td=el('td','py-1 pr-3');
      var bar=el('div','h-1.5 rounded bg-emerald-500/70');bar.style.width=Math.max(4,Math.round(v/max[k]*72))+'px';
      td.appendChild(el('div','tabular-nums text-zinc-200',String(v)));td.appendChild(bar);tr.appendChild(td)});
    tbl.appendChild(tr)});
  var sp=$('spend');sp.textContent='';
  (data.hosted_spend||[]).forEach(function(r){var tr=el('tr','border-t border-zinc-900');
    tr.appendChild(el('td','py-1 pr-3',r.month));tr.appendChild(el('td','py-1 pr-3',r.model));
    tr.appendChild(el('td','py-1 pr-3 tabular-nums text-right',String(r.calls)));
    tr.appendChild(el('td','py-1 pr-3 tabular-nums text-right','$'+(r.spent_microusd/1e6).toFixed(4)));sp.appendChild(tr)});
  if(!(data.hosted_spend||[]).length){var tr=el('tr');tr.appendChild(el('td','py-2 text-zinc-600','no hosted spend yet (opens at G5)'));sp.appendChild(tr)}
}
function load(){var tok='';try{tok=localStorage.getItem('dl_admin_token')||''}catch(e){}
  if(!tok){$('login').hidden=false;$('dash').hidden=true;return}
  fetch('/admin/metrics',{headers:{authorization:'Bearer '+tok}}).then(function(r){
    if(r.status===401){try{localStorage.removeItem('dl_admin_token')}catch(e){};$('login').hidden=false;$('dash').hidden=true;$('login-status').textContent='that token was rejected';return null}
    return r.json()}).then(function(d){if(d)render(d)}).catch(function(){$('login-status').textContent='fetch failed'})}
$('login-save').onclick=function(){var v=$('login-token').value.trim();if(!v)return;try{localStorage.setItem('dl_admin_token',v)}catch(e){};load()};
$('dash-logout').onclick=function(){try{localStorage.removeItem('dl_admin_token')}catch(e){};load()};
$('dash-refresh').onclick=load;
load();
})();`;

adminRoutes.get('/admin', async (c) => {
  // Public shell, no data, no auth — every number arrives via the token-gated
  // JSON endpoint. The middleware above scopes /admin/* — carve this one out.
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ops · Deep League</title><meta name="robots" content="noindex"/>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen"><main class="max-w-5xl mx-auto px-4 py-8">
<div class="flex items-baseline justify-between mb-6"><h1 class="text-2xl font-bold">Deep League ops</h1>
<div class="text-xs text-zinc-500 flex gap-3"><button id="dash-refresh" class="hover:text-zinc-200 underline">refresh</button>
<button id="dash-logout" class="hover:text-zinc-200 underline">forget token</button></div></div>
<div id="login" hidden class="max-w-md rounded border border-zinc-800 p-4">
<p class="text-sm text-zinc-400 mb-2">Paste the admin token (on mt-asus: <code class="text-zinc-300">cat ~/.local/state/deep-league/admin-token</code>). Stored only in this browser.</p>
<div class="flex gap-2"><input id="login-token" type="password" class="flex-1 rounded bg-zinc-900 border border-zinc-800 p-2 text-sm" placeholder="admin token"/>
<button id="login-save" class="rounded bg-emerald-500 text-zinc-950 text-sm font-semibold px-3">open</button></div>
<p id="login-status" class="mt-2 text-xs text-amber-400"></p></div>
<div id="dash" hidden>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">today so far (UTC)</h2>
<div id="tiles" class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8"></div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">last 14 days</h2>
<div class="overflow-x-auto mb-8"><table class="w-full text-xs"><tbody id="days"></tbody></table></div>
<h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">hosted inference spend</h2>
<table class="text-sm"><tbody id="spend"></tbody></table></div>
</main><script>${DASH_JS}</script></body></html>`);
});

// §7 instrumentation JSON: daily snapshots (finalized by the nightly cron)
// plus a live "today so far" row. The dashboard above consumes this.
adminRoutes.get('/admin/metrics', async (c) => {
  const { computeDayMetrics } = await import('../cron/metrics');
  const rows = await c.env.DB.prepare(
    'SELECT day, metric, value FROM metrics_daily ORDER BY day DESC, metric ASC LIMIT 600',
  ).all<{ day: string; metric: string; value: number }>();
  const days = new Map<string, Record<string, number>>();
  for (const r of rows.results) {
    if (!days.has(r.day)) days.set(r.day, {});
    days.get(r.day)![r.metric] = r.value;
  }
  const today = await computeDayMetrics(c.env.DB, new Date().toISOString().slice(0, 10));
  const spend = await c.env.DB.prepare(
    'SELECT month, model, calls, spent_microusd FROM hosted_spend ORDER BY month DESC, model ASC LIMIT 40',
  ).all();
  return c.json({
    today_so_far: today,
    days: [...days.entries()].map(([day, metrics]) => ({ day, metrics })),
    hosted_spend: spend.results,
  });
});
