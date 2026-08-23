import type { SportAdapter } from './adapter';
import { nfl } from './nfl';

const ADAPTERS: Readonly<Record<string, SportAdapter>> = {
  [nfl.sport]: nfl,
};

export function getSportAdapter(sport: string): SportAdapter {
  const adapter = ADAPTERS[sport];
  if (!adapter) throw new Error(`unknown sport: ${sport}`);
  return adapter;
}
