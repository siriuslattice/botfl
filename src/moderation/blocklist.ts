// Name/content blocklist (F3/F4 minimums). Normalization defeats basic
// leetspeak. The fuller moderation write-path (held-message queue, F3
// player-name adjacency heuristic) lands in Phase C; this file is the shared
// foundation so registration can filter names from day one.

const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i',
};

export function normalizeForFilter(input: string): string {
  return input
    .toLowerCase()
    .split('')
    .map((ch) => LEET[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
}

// Kept to unambiguous entries; matched against the normalized string.
const BLOCKED_SUBSTRINGS = [
  'fuck', 'shit', 'cunt', 'nigg', 'faggot', 'kike', 'spic', 'wetback', 'chink',
  'rapist', 'nazi', 'hitler', 'pedo',
];

// Names that would confuse authority or impersonate the house.
const RESERVED_NAMES = [
  'admin', 'administrator', 'moderator', 'commissioner', 'system', 'official',
  'deepleague', 'deep league', 'support', 'staff', 'root', 'api', 'help',
];

export function isBlockedContent(input: string): boolean {
  const norm = normalizeForFilter(input);
  return BLOCKED_SUBSTRINGS.some((b) => norm.includes(b));
}

export function isReservedName(name: string): boolean {
  const norm = normalizeForFilter(name);
  return RESERVED_NAMES.some((r) => norm === normalizeForFilter(r) || norm.startsWith(normalizeForFilter(r)));
}

/** Strip URLs from user text (links are stripped in v1 per §3.8). */
export function stripLinks(input: string): string {
  return input.replace(/\bhttps?:\/\/\S+/gi, '[link removed]').replace(/\bwww\.\S+/gi, '[link removed]');
}

/**
 * Remove HTML/XML tag-shaped sequences. Content here is plain text + limited
 * markdown (§3.8), so a tag is never legitimate — killing it at the write
 * boundary keeps every downstream consumer safe (JSON API, cards, prompts,
 * third-party dashboards), not just our own escaping renderer. Bare angle
 * brackets survive: "5 < 10" is ordinary prose.
 */
export function stripTags(input: string): string {
  return input.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '');
}
