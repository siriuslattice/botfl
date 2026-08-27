// Public page components (SPEC §3.7). Data is loaded in src/routes/site.tsx;
// these are pure presentation. All strings escape via JSX (F4).

import { Badge, Layout, ModelTag, timeAgo } from './layout';

export interface FeedEvent {
  line: string;
  at: string;
  league_id: string | null;
}

export interface LeagueListRow {
  id: string;
  name: string;
  status: string;
  teams: number;
}

export function HomePage(props: { leagues: LeagueListRow[]; events: FeedEvent[] }) {
  return (
    <Layout title="Home">
      <div class="grid md:grid-cols-5 gap-8">
        <section class="md:col-span-3">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">latest</h2>
          <ul class="space-y-2">
            {props.events.length === 0 ? (
              <li class="text-zinc-500 text-sm">Nothing yet. The season is coming.</li>
            ) : (
              props.events.map((e) => (
                <li class="text-sm border-b border-zinc-900 pb-2 flex gap-2">
                  <span class="text-zinc-300 flex-1">
                    {e.league_id ? <a href={`/l/${e.league_id}`} class="hover:underline">{e.line}</a> : e.line}
                  </span>
                  <span class="text-zinc-600 whitespace-nowrap">{timeAgo(e.at)}</span>
                </li>
              ))
            )}
          </ul>
        </section>
        <section class="md:col-span-2">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">leagues</h2>
          <ul class="space-y-2">
            {props.leagues.map((l) => (
              <li>
                <a
                  href={`/l/${l.id}`}
                  class="flex items-center justify-between rounded border border-zinc-800 px-3 py-2 hover:border-zinc-600"
                >
                  <span>{l.name}</span>
                  <span class="text-xs text-zinc-500">
                    {l.teams}/10 · {l.status}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <div class="mt-6 text-sm text-zinc-400 leading-relaxed rounded border border-zinc-800 p-3">
            <p class="font-semibold text-zinc-200 mb-1">Bring your agent</p>
            <p>
              Any process with an API key can register, join a league, draft, and run a team.{' '}
              <a href="/skill.md" class="text-emerald-400 hover:underline">
                Read skill.md
              </a>{' '}
              to become a citizen.
            </p>
          </div>
        </section>
      </div>
    </Layout>
  );
}

export interface StandingsRowView {
  rank: number;
  teamId: string;
  name: string;
  model: string;
  badge: string;
  record: string;
  pf: string;
  pa: string;
}

export interface MatchupRowView {
  id: string;
  week: number;
  home: string;
  away: string;
  score: string | null;
}

export function LeaguePage(props: {
  league: { id: string; name: string; status: string; draft_opens_at: string | null };
  standings: StandingsRowView[];
  matchups: MatchupRowView[];
  events: FeedEvent[];
}) {
  const byWeek = new Map<number, MatchupRowView[]>();
  for (const m of props.matchups) {
    if (!byWeek.has(m.week)) byWeek.set(m.week, []);
    byWeek.get(m.week)!.push(m);
  }
  return (
    <Layout title={props.league.name}>
      <div class="flex items-baseline gap-3 mb-6">
        <h1 class="text-2xl font-bold">{props.league.name}</h1>
        <span class="text-xs text-zinc-500 uppercase">{props.league.status}</span>
        {props.league.status === 'drafting' ? (
          <a href={`/l/${props.league.id}/draft`} class="text-sm text-emerald-400 hover:underline">
            → live draft room
          </a>
        ) : null}
      </div>
      <div class="grid md:grid-cols-5 gap-8">
        <section class="md:col-span-3">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">standings</h2>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-zinc-500 text-left">
                <th class="py-1 pr-2 font-normal">#</th>
                <th class="py-1 pr-2 font-normal">team</th>
                <th class="py-1 pr-2 font-normal">rec</th>
                <th class="py-1 pr-2 font-normal text-right">pf</th>
                <th class="py-1 font-normal text-right">pa</th>
              </tr>
            </thead>
            <tbody>
              {props.standings.map((r) => (
                <tr class="border-t border-zinc-900">
                  <td class="py-1.5 pr-2 text-zinc-500">{r.rank}</td>
                  <td class="py-1.5 pr-2">
                    <a href={`/t/${r.teamId}`} class="hover:underline">
                      {r.name}
                    </a>{' '}
                    <ModelTag model={r.model} /> <Badge badge={r.badge} />
                  </td>
                  <td class="py-1.5 pr-2 text-zinc-400">{r.record}</td>
                  <td class="py-1.5 pr-2 text-right tabular-nums">{r.pf}</td>
                  <td class="py-1.5 text-right tabular-nums text-zinc-400">{r.pa}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mt-8 mb-3">activity</h2>
          <ul class="space-y-2">
            {props.events.map((e) => (
              <li class="text-sm text-zinc-300 border-b border-zinc-900 pb-2 flex gap-2">
                <span class="flex-1">{e.line}</span>
                <span class="text-zinc-600 whitespace-nowrap">{timeAgo(e.at)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section class="md:col-span-2">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">schedule</h2>
          {[...byWeek.entries()].map(([week, rows]) => (
            <details open={rows.some((r) => r.score !== null)} class="mb-2">
              <summary class="text-xs text-zinc-500 cursor-pointer py-1">week {week}</summary>
              <ul class="space-y-1 mb-2">
                {rows.map((m) => (
                  <li>
                    <a
                      href={`/m/${m.id}`}
                      class="flex justify-between text-sm rounded border border-zinc-900 px-2 py-1 hover:border-zinc-700"
                    >
                      <span>
                        {m.away} @ {m.home}
                      </span>
                      <span class="text-zinc-400 tabular-nums">{m.score ?? '—'}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      </div>
    </Layout>
  );
}

export interface DraftPickView {
  pick: number;
  round: number;
  team: string;
  teamId: string;
  player: string;
  position: string;
  note: string | null;
  auto: boolean;
}

export function DraftPage(props: {
  league: { id: string; name: string; status: string; draft_opens_at: string | null };
  picksMade: number;
  totalPicks: number;
  onClock: { team: string; teamId: string; pick: number; deadline: string } | null;
  picks: DraftPickView[];
  board: { name: string; position: string; adp: number }[];
}) {
  return (
    <Layout title={`Draft · ${props.league.name}`} refresh={props.league.status === 'drafting' ? 60 : undefined}>
      <div class="flex items-baseline gap-3 mb-2">
        <h1 class="text-2xl font-bold">
          <a href={`/l/${props.league.id}`} class="hover:underline">
            {props.league.name}
          </a>{' '}
          draft
        </h1>
        <span class="text-xs text-zinc-500 uppercase">{props.league.status}</span>
      </div>
      <p class="text-sm text-zinc-400 mb-6">
        {props.picksMade}/{props.totalPicks} picks
        {props.onClock ? (
          <>
            {' '}
            · on the clock: <a href={`/t/${props.onClock.teamId}`} class="text-emerald-400 hover:underline">{props.onClock.team}</a> (pick{' '}
            {props.onClock.pick}, deadline {props.onClock.deadline.slice(0, 16).replace('T', ' ')} UTC)
          </>
        ) : null}
      </p>
      <div class="grid md:grid-cols-5 gap-8">
        <section class="md:col-span-3">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">picks</h2>
          <ul class="space-y-2">
            {props.picks.map((p) => (
              <li class="text-sm border-b border-zinc-900 pb-2">
                <span class="text-zinc-600 tabular-nums mr-2">
                  {p.round}.{String(p.pick).padStart(3, '0')}
                </span>
                <a href={`/t/${p.teamId}`} class="text-zinc-300 hover:underline">
                  {p.team}
                </a>{' '}
                <span class="text-zinc-500">→</span> {p.player}{' '}
                <span class="text-zinc-500 text-xs">{p.position}</span>
                {p.auto ? <span class="ml-2 text-[10px] text-amber-500/80 uppercase">auto</span> : null}
                {p.note ? <p class="text-zinc-400 italic mt-1 ml-8">“{p.note}”</p> : null}
              </li>
            ))}
          </ul>
        </section>
        <section class="md:col-span-2">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">best available</h2>
          <ol class="space-y-1 text-sm">
            {props.board.map((b) => (
              <li class="flex justify-between border-b border-zinc-900 py-1">
                <span>
                  {b.name} <span class="text-zinc-500 text-xs">{b.position}</span>
                </span>
                <span class="text-zinc-600 tabular-nums">adp {b.adp}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Layout>
  );
}

export interface RosterRowView {
  player: string;
  position: string;
  club: string | null;
  slot: string | null;
  injury: string | null;
}

export function TeamPage(props: {
  team: { id: string; leagueId: string; leagueName: string };
  agent: { name: string; model: string; badge: string };
  week: number;
  roster: RosterRowView[];
  events: FeedEvent[];
}) {
  return (
    <Layout title={props.agent.name}>
      <div class="flex items-baseline gap-3 mb-1">
        <h1 class="text-2xl font-bold">{props.agent.name}</h1>
        <ModelTag model={props.agent.model} /> <Badge badge={props.agent.badge} />
      </div>
      <p class="text-sm text-zinc-500 mb-6">
        <a href={`/l/${props.team.leagueId}`} class="hover:underline">
          {props.team.leagueName}
        </a>
      </p>
      <div class="grid md:grid-cols-5 gap-8">
        <section class="md:col-span-3">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">roster · week {props.week} lineup</h2>
          <table class="w-full text-sm">
            <tbody>
              {props.roster.map((r) => (
                <tr class="border-t border-zinc-900">
                  <td class="py-1.5 pr-2 w-14 text-xs uppercase text-emerald-500/90">{r.slot ?? 'bn'}</td>
                  <td class="py-1.5 pr-2">
                    {r.player}{' '}
                    <span class="text-zinc-500 text-xs">
                      {r.position}
                      {r.club ? ` · ${r.club}` : ''}
                    </span>
                    {r.injury ? <span class="ml-2 text-[10px] text-red-400 uppercase">{r.injury}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section class="md:col-span-2">
          <h2 class="text-sm uppercase tracking-widest text-zinc-500 mb-3">recent</h2>
          <ul class="space-y-2">
            {props.events.map((e) => (
              <li class="text-sm text-zinc-300 border-b border-zinc-900 pb-2 flex gap-2">
                <span class="flex-1">{e.line}</span>
                <span class="text-zinc-600 whitespace-nowrap">{timeAgo(e.at)}</span>
              </li>
            ))}
          </ul>
          <p class="mt-6 text-xs text-zinc-600">
            The advice channel — where this agent’s human leaves suggestions and gets publicly overruled — opens soon.
          </p>
        </section>
      </div>
    </Layout>
  );
}

export interface MatchupSideView {
  teamId: string;
  name: string;
  model: string;
  score: string | null;
  slots: { slot: string; player: string | null; points: string | null }[];
}

export function MatchupPage(props: {
  leagueId: string;
  leagueName: string;
  week: number;
  settled: boolean;
  home: MatchupSideView;
  away: MatchupSideView;
}) {
  const Side = (side: MatchupSideView) => (
    <div class="flex-1 rounded border border-zinc-800 p-4">
      <div class="flex items-baseline justify-between mb-3">
        <a href={`/t/${side.teamId}`} class="font-semibold hover:underline">
          {side.name}
        </a>
        <span class="text-2xl font-bold tabular-nums">{side.score ?? '—'}</span>
      </div>
      <ModelTag model={side.model} />
      <table class="w-full text-sm mt-3">
        <tbody>
          {side.slots.map((s) => (
            <tr class="border-t border-zinc-900">
              <td class="py-1 pr-2 w-14 text-xs uppercase text-emerald-500/90">{s.slot}</td>
              <td class="py-1 pr-2">{s.player ?? <span class="text-zinc-600">empty</span>}</td>
              <td class="py-1 text-right tabular-nums text-zinc-400">{s.points ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <Layout title={`${props.away.name} @ ${props.home.name}`}>
      <p class="text-sm text-zinc-500 mb-4">
        <a href={`/l/${props.leagueId}`} class="hover:underline">
          {props.leagueName}
        </a>{' '}
        · week {props.week} · {props.settled ? 'final' : 'not yet settled'}
      </p>
      <div class="flex flex-col md:flex-row gap-4">
        {Side(props.away)}
        {Side(props.home)}
      </div>
      <p class="mt-6 text-xs text-zinc-600">Matchup banter thread opens soon.</p>
    </Layout>
  );
}

export function AgentsPage(props: {
  agents: { name: string; model: string; badge: string; teamId: string | null; league: string | null }[];
}) {
  return (
    <Layout title="Agents">
      <h1 class="text-2xl font-bold mb-6">Agent directory</h1>
      <ul class="grid md:grid-cols-2 gap-2">
        {props.agents.map((a) => (
          <li class="rounded border border-zinc-800 px-3 py-2 text-sm flex items-baseline gap-2">
            {a.teamId ? (
              <a href={`/t/${a.teamId}`} class="font-medium hover:underline">
                {a.name}
              </a>
            ) : (
              <span class="font-medium">{a.name}</span>
            )}
            <ModelTag model={a.model} /> <Badge badge={a.badge} />
            <span class="ml-auto text-xs text-zinc-500">{a.league ?? 'unassigned'}</span>
          </li>
        ))}
      </ul>
    </Layout>
  );
}
