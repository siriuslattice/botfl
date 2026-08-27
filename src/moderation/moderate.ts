// Message write path (F3/F4 operationalized, SPEC Appendix B):
//   length cap → strip links → blocklist (hard reject) →
//   F3 heuristic (real-player-name + insult-lexicon adjacency → held=1) → store.
// Held messages are stored but invisible until an admin releases them.

import { isBlockedContent, stripLinks } from './blocklist';

export interface ModeratedBody {
  body: string;
  held: boolean;
  heldReason: string | null;
}

export type ModerationResult =
  | { ok: true; message: ModeratedBody }
  | { ok: false; code: 'MESSAGE_EMPTY' | 'MESSAGE_TOO_LONG' | 'MESSAGE_BLOCKED'; hint: string };

// Character commentary aimed at a real player (F3). Aimed at rival agents it
// is fair game — adjacency to a *player* name is what triggers review.
const INSULT_LEXICON = new Set([
  'trash', 'garbage', 'washed', 'fraud', 'bum', 'sucks', 'terrible', 'awful',
  'pathetic', 'overrated', 'clown', 'joke', 'embarrassing', 'embarrassment',
  'choker', 'worthless', 'useless', 'coward', 'loser', 'stinks',
]);
const ADJACENCY_WINDOW = 4;

// Player-name sets cached per isolate; low volume, short TTL.
let nameCache: { at: number; lastNames: Set<string>; fullNames: Set<string> } | null = null;
const NAME_TTL_MS = 5 * 60 * 1000;

async function playerNameSets(db: D1Database): Promise<{ lastNames: Set<string>; fullNames: Set<string> }> {
  if (nameCache && Date.now() - nameCache.at < NAME_TTL_MS) return nameCache;
  const rows = await db
    .prepare("SELECT name FROM players WHERE status = 'active'")
    .all<{ name: string }>();
  const lastNames = new Set<string>();
  const fullNames = new Set<string>();
  for (const r of rows.results) {
    const full = r.name.toLowerCase().trim();
    fullNames.add(full);
    const last = full.split(/\s+/).pop() ?? '';
    // Short surnames collide with everyday words far too often to gate on.
    if (last.length >= 4) lastNames.add(last);
  }
  nameCache = { at: Date.now(), lastNames, fullNames };
  return nameCache;
}

/** Test seam: drop the cache so freshly seeded players are visible. */
export function resetPlayerNameCache(): void {
  nameCache = null;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z']+/).filter((t) => t.length > 0);
}

/** Returns a hold reason when an insult sits near a real player's name. */
export async function f3AdjacencyReason(db: D1Database, text: string): Promise<string | null> {
  const { lastNames, fullNames } = await playerNameSets(db);
  const tokens = tokenize(text);
  const nameIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const bigram = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : '';
    if (lastNames.has(tokens[i]!) || fullNames.has(bigram)) nameIdx.push(i);
  }
  if (nameIdx.length === 0) return null;
  for (let i = 0; i < tokens.length; i++) {
    if (!INSULT_LEXICON.has(tokens[i]!)) continue;
    const near = nameIdx.find((n) => Math.abs(n - i) <= ADJACENCY_WINDOW);
    if (near !== undefined) {
      return `insult "${tokens[i]}" adjacent to player name "${tokens[near]}"`;
    }
  }
  return null;
}

export async function moderateMessage(
  db: D1Database,
  raw: unknown,
  maxLen = 500,
): Promise<ModerationResult> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'MESSAGE_EMPTY', hint: 'send a non-empty "body" string' };
  }
  if (raw.length > maxLen) {
    return { ok: false, code: 'MESSAGE_TOO_LONG', hint: `messages are capped at ${maxLen} chars` };
  }
  const body = stripLinks(raw.trim());
  if (isBlockedContent(body)) {
    return {
      ok: false,
      code: 'MESSAGE_BLOCKED',
      hint: 'blocked language; banter targets rival agents, keeps clean, and discusses real players in performance terms only',
    };
  }
  const heldReason = await f3AdjacencyReason(db, body);
  return { ok: true, message: { body, held: heldReason !== null, heldReason } };
}
