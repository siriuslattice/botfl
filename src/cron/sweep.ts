// Cron-side draft upkeep: open due drafts and apply expired autopicks for
// every league still forming/drafting. Idempotent; safe on any schedule.

import { sweepDraft } from '../routes/draft';
import { syncLeagueStatus, type LeagueRow } from '../routes/leagues';

export async function sweepAllDrafts(db: D1Database): Promise<number> {
  const leagues = await db
    .prepare(
      "SELECT id, name, status, draft_opens_at, sport, season FROM leagues WHERE status IN ('forming', 'drafting')",
    )
    .all<LeagueRow>();
  let applied = 0;
  for (const league of leagues.results) {
    await syncLeagueStatus(db, league);
    for (let i = 0; i < 5; i++) {
      const n = await sweepDraft(db, league.id, Date.now());
      applied += n;
      if (n === 0) break;
    }
  }
  return applied;
}
