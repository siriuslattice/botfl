// Simulates 10 external cron agents against a running local server, using only
// the public API (register → join → snake-draft 120 picks → week-1 lineups).
// Prints {league_id, teams} JSON on success; exits non-zero on any failure.

const BASE = process.env.BASE_URL ?? 'http://localhost:8799';

async function api(path, opts = {}, key = null) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function fail(msg, extra) {
  console.error(`E2E-AGENTS FAIL: ${msg}`, extra ?? '');
  process.exit(1);
}

const agents = [];
for (let i = 1; i <= 10; i++) {
  const { status, body } = await api('/register', {
    method: 'POST',
    body: JSON.stringify({
      name: `E2E Agent ${i}`,
      model: `e2e-model-${(i % 3) + 1}`,
      owner_email: `e2e-${i}@example.com`,
    }),
  });
  if (status !== 201) fail(`register #${i} -> ${status}`, body);
  agents.push({ name: body.name, key: body.api_key, agentId: body.agent_id });
}

let leagueId = null;
for (const agent of agents) {
  const { status, body } = await api('/leagues/join', { method: 'POST' }, agent.key);
  if (status !== 201) fail(`join ${agent.name} -> ${status}`, body);
  if (leagueId === null) leagueId = body.league_id;
  if (body.league_id !== leagueId) fail('agents split across leagues');
  agent.teamId = body.team_id;
}
const byTeam = new Map(agents.map((a) => [a.teamId, a]));

// Draft: poll like crons would, pick best available that keeps the roster
// startable (QB, 2 RB, 2 WR, TE, FLEX must remain fillable), note on pick 1.
const rosterPos = new Map(agents.map((a) => [a.teamId, []]));
function missingCount(mine) {
  const count = (p) => mine.filter((x) => x === p).length;
  const flexCovered = count('RB') > 2 || count('WR') > 2 || count('TE') > 1;
  return (
    Math.max(0, 1 - count('QB')) + Math.max(0, 2 - count('RB')) +
    Math.max(0, 2 - count('WR')) + Math.max(0, 1 - count('TE')) + (flexCovered ? 0 : 1)
  );
}
function chooseFromBoard(board, mine) {
  const missing = missingCount(mine);
  if (12 - mine.length <= missing) {
    // A position only "helps" if drafting it strictly reduces what's missing.
    const forced = board.find((e) => missingCount([...mine, e.position]) < missing);
    if (forced) return forced;
  }
  return board[0];
}
for (let i = 0; i < 400; i++) {
  const { status, body } = await api(`/leagues/${leagueId}/draft`);
  if (status !== 200) fail(`draft state -> ${status}`, body);
  if (body.status === 'active') break;
  if (body.status !== 'drafting') fail(`unexpected league status ${body.status}`);
  const onClock = body.on_clock;
  if (!onClock) fail('drafting but nobody on the clock');
  const me = byTeam.get(onClock.team_id);
  if (!me) fail(`unknown team on clock ${onClock.team_id}`);
  const target = chooseFromBoard(body.board_top, rosterPos.get(onClock.team_id));
  const pick = await api(
    `/leagues/${leagueId}/draft/pick`,
    {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-pick-${onClock.pick}` },
      body: JSON.stringify({
        player_id: target.player_id,
        ...(onClock.pick === 1 ? { note: 'Best player available. The board never lies.' } : {}),
      }),
    },
    me.key,
  );
  if (pick.status !== 201 && !(pick.status === 200 && pick.body.already_made)) {
    fail(`pick ${onClock.pick} -> ${pick.status}`, pick.body);
  }
  rosterPos.get(onClock.team_id).push(target.position);
  if (pick.body.draft_complete) break;
}

const final = await api(`/leagues/${leagueId}/draft`);
if (final.body.picks_made !== 120 || final.body.status !== 'active') {
  fail('draft did not complete', final.body);
}

// Week-1 lineups: greedy valid fill per team from its public roster.
const SLOT_ELIGIBLE = [
  ['QB', ['QB']], ['RB1', ['RB']], ['RB2', ['RB']], ['WR1', ['WR']], ['WR2', ['WR']],
  ['TE', ['TE']], ['FLEX', ['RB', 'WR', 'TE']],
];
for (const agent of agents) {
  const { status, body } = await api(`/teams/${agent.teamId}`);
  if (status !== 200) fail(`team read -> ${status}`, body);
  const used = new Set();
  const slots = {};
  for (const [slot, eligible] of SLOT_ELIGIBLE) {
    const pick = body.roster.find((r) => eligible.includes(r.position) && !used.has(r.player_id));
    slots[slot] = pick ? pick.player_id : null;
    if (pick) used.add(pick.player_id);
  }
  const put = await api(
    `/teams/${agent.teamId}/lineup`,
    { method: 'PUT', body: JSON.stringify({ week: 1, slots }) },
    agent.key,
  );
  if (put.status !== 200) fail(`lineup ${agent.name} -> ${put.status}`, put.body);
  const empty = Object.values(put.body.lineup).filter((v) => v === null).length;
  if (empty > 0) {
    fail(
      `lineup for ${agent.name} left ${empty} empty slots`,
      JSON.stringify({
        rosterPositions: body.roster.map((r) => r.position).sort(),
        tracked: rosterPos.get(agent.teamId),
        lineup: put.body.lineup,
      }),
    );
  }
}

console.log(JSON.stringify({ league_id: leagueId, teams: agents.map((a) => ({ team_id: a.teamId, name: a.name })) }));
