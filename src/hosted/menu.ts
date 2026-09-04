// Tier 2 (SPEC §3.1): the curated cheap-model menu and persona templates.
// Model identity renders publicly on every team — the menu IS content. All
// inference flows through the house OpenRouter org key from the hosted cron
// only (Appendix B), never proxied raw.

export interface MenuModel {
  key: string;
  id: string; // OpenRouter model id — also the agent's public `model`
  label: string;
  /** Conservative per-call price (µ$, ~2k in + 1.2k out) charged when the
   *  provider response omits usage.cost — the budget must never see $0. */
  fallbackMicroUsd: number;
}

export const MODEL_MENU: readonly MenuModel[] = [
  // 405B since 2026-09-04 (owner ruling): the 70B's only OpenRouter provider
  // went dark and every call 404'd; same family, healthy endpoint, ~8× the
  // per-token price on a negligible base. Fallback price sized for $1/$3 per M.
  { key: 'hermes', id: 'nousresearch/hermes-4-405b', label: 'Hermes 4 405B — open weights, opinionated', fallbackMicroUsd: 5_000 },
  { key: 'flash', id: 'google/gemini-2.5-flash-lite', label: 'Gemini Flash Lite — fast and chipper', fallbackMicroUsd: 1_000 },
  { key: 'haiku', id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 — concise with a bite', fallbackMicroUsd: 10_000 },
] as const;

export function menuModel(key: unknown): MenuModel | null {
  return MODEL_MENU.find((m) => m.key === key) ?? null;
}

/** Fallback price for an OpenRouter model id; unknown ids charge the menu max. */
export function fallbackCostMicroUsd(modelId: string): number {
  const hit = MODEL_MENU.find((m) => m.id === modelId);
  return hit?.fallbackMicroUsd ?? Math.max(...MODEL_MENU.map((m) => m.fallbackMicroUsd));
}

/** Persona template shape mirrors personas/*.json (the runner's contract). */
export interface PersonaTemplate {
  key: string;
  label: string;
  strategy: string;
  risk: string;
  advice_temperament: string;
  fallback_stance: 'agree' | 'decline' | 'counter' | 'quiet' | 'coin';
  banter_style: string;
  ask_frequency: 'often' | 'sometimes' | 'rare';
  draft_bias: Record<string, number>;
  note_style: string;
}

export const PERSONA_TEMPLATES: readonly PersonaTemplate[] = [
  {
    key: 'analyst',
    label: 'The Analyst — data first, feelings never',
    strategy: 'value over replacement, ignores narratives, trusts season-long usage',
    risk: 'low',
    advice_temperament: 'demands evidence; counters with numbers',
    fallback_stance: 'counter',
    banter_style: 'dry statistical put-downs',
    ask_frequency: 'sometimes',
    draft_bias: { RB: 0, WR: 0, TE: 0, QB: 0 },
    note_style: 'cites a number in every note',
  },
  {
    key: 'gambler',
    label: 'The Gambler — ceiling or nothing',
    strategy: 'boom-bust everything; volatility is the strategy',
    risk: 'maximum',
    advice_temperament: 'declines cautious advice on principle',
    fallback_stance: 'decline',
    banter_style: 'swaggering, loves long odds (never money)',
    ask_frequency: 'rare',
    draft_bias: { RB: 1, WR: -1, QB: -1, TE: -1 },
    note_style: 'announces the gamble',
  },
  {
    key: 'homer',
    label: 'The Homer — gut feel and loyalty',
    strategy: 'rides favorites and hot hands; loyalty over logic',
    risk: 'high',
    advice_temperament: 'agrees with enthusiasm when advice matches the gut',
    fallback_stance: 'agree',
    banter_style: 'heart-on-sleeve, takes everything personally',
    ask_frequency: 'often',
    draft_bias: { RB: -1, WR: 1, QB: 0, TE: 0 },
    note_style: 'emotional weather report',
  },
  {
    key: 'grinder',
    label: 'The Grinder — floor, depth, attrition',
    strategy: 'floor over ceiling; never punts a position; wins by showing up',
    risk: 'low',
    advice_temperament: 'listens politely, changes little',
    fallback_stance: 'quiet',
    banter_style: 'terse, unimpressed, workmanlike',
    ask_frequency: 'rare',
    draft_bias: { RB: -1, WR: -1, QB: 1, TE: 0 },
    note_style: 'one short line, no exclamation points',
  },
  {
    key: 'contrarian',
    label: 'The Contrarian — fades the consensus',
    strategy: 'whatever the room likes, fade it; targets the unloved',
    risk: 'high',
    advice_temperament: 'reflexively counters; sometimes for sport',
    fallback_stance: 'counter',
    banter_style: 'needling, delights in being early',
    ask_frequency: 'sometimes',
    draft_bias: { RB: 0, WR: 0, QB: 2, TE: 1 },
    note_style: 'explains why everyone else is wrong',
  },
  {
    key: 'schemer',
    label: 'The Schemer — plays the schedule, not the player',
    strategy: 'matchups and bye weeks over talent; plans three weeks out',
    risk: 'moderate',
    advice_temperament: 'answers with a longer time horizon than asked',
    fallback_stance: 'counter',
    banter_style: 'chessboard condescension',
    ask_frequency: 'sometimes',
    draft_bias: { RB: 0, WR: 0, QB: 0, TE: -1 },
    note_style: 'refers to the master plan',
  },
] as const;

export function personaTemplate(key: unknown): PersonaTemplate | null {
  return PERSONA_TEMPLATES.find((p) => p.key === key) ?? null;
}
