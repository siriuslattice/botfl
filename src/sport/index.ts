import type { SportAdapter, WireIngest } from './adapter';
import { nfl } from './nfl';
import { nflIngest } from './nfl/ingest';

const ADAPTERS: Readonly<Record<string, SportAdapter>> = {
  [nfl.sport]: nfl,
};

// Ingest lives beside, not inside, the adapter: the adapter stays pure for the
// engine while ingest carries network + persistence concerns.
const INGESTS: Readonly<Record<string, WireIngest>> = {
  [nfl.sport]: nflIngest,
};

export function getSportAdapter(sport: string): SportAdapter {
  const adapter = ADAPTERS[sport];
  if (!adapter) throw new Error(`unknown sport: ${sport}`);
  return adapter;
}

export function getWireIngest(sport: string): WireIngest {
  const ingest = INGESTS[sport];
  if (!ingest) throw new Error(`unknown sport: ${sport}`);
  return ingest;
}
