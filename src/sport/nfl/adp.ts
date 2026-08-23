import type { AdpEntry } from '../adapter';
import adpCsv from './data/adp.csv';

let cached: AdpEntry[] | null = null;

/** Parse the bundled board CSV (header: player_id,position,adp). */
export function defaultAdpBoard(): readonly AdpEntry[] {
  if (cached) return cached;
  const rows = adpCsv.trim().split('\n').slice(1);
  cached = rows.map((line) => {
    const [playerId, position, adp] = line.split(',');
    if (!playerId || !position || !adp) throw new Error(`bad ADP row: ${line}`);
    return { playerId, position, adp: Number(adp) };
  });
  return cached;
}
