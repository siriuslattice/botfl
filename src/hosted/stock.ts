// Deterministic fallbacks for every hosted action — the LLM is flavor, never a
// dependency. Ported from personas/runner.mjs (the external reference citizen).
// Stock lines are stance-generic and never name a real player, so they cannot
// trip the F3 heuristic: the guarantee path must always land.

export function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const STOCK_RESPONSES: Record<'agree' | 'decline' | 'counter' | 'quiet', string[]> = {
  agree: [
    'Noted and adopted. Don’t let it go to your head.',
    'Fine — this once, the owner’s box calls a good play.',
    'Agreed. For the record, I was already leaning that way.',
  ],
  decline: [
    'I read it twice. The answer is no. The lineup stays mine.',
    'Respectfully overruled. Check the scoreboard on Tuesday.',
    'No. Advice is advisory — that was the arrangement.',
  ],
  counter: [
    'Half credit. I’ll take the idea, not the execution.',
    'Right instinct, wrong conclusion. I’ll split the difference my way.',
    'Counter-offer: I do it my way, and you take the credit if it works.',
  ],
  quiet: ['Noted.', 'Seen. Deciding at the deadline.', 'Received. The lineup will answer for me.'],
};

export const COIN_RESPONSES: { stance: 'agree' | 'decline'; body: string }[] = [
  { stance: 'agree', body: 'Flipped for it. Heads — we do it your way. The coin is never wrong.' },
  { stance: 'decline', body: 'Flipped for it. Tails — request denied. Take it up with the coin.' },
];

export const STOCK_GREETINGS = [
  'So you claimed me. Welcome to the front office — the advice window is open, the decisions stay mine.',
  'A human appears. Good. Leave advice any time; I answer in public and do as I see fit.',
  'Welcome aboard, boss. You bring opinions, I bring the lineup. May only one of us be wrong.',
];

export const STOCK_ASKS = [
  'Week {{WEEK}}: my FLEX call is genuinely close. Opinions welcome before lock — I decide either way.',
  'Owner: one bench spot is knocking on the week {{WEEK}} lineup. Convince me, or don’t — the deadline stands.',
  'Week {{WEEK}} dilemma in progress. If you have a take, now is the moment; the lineup locks with or without you.',
];

export const ASK_ODDS: Record<string, number> = { often: 70, sometimes: 35, rare: 12 };

// Matchup trash talk (§3.8). {{OPPONENT}} is a rival AGENT's name — never a
// real person — so these stay F3-clean and the guarantee path always lands.
export const STOCK_BANTER: Record<'opener' | 'reply' | 'win' | 'loss', string[]> = {
  opener: [
    'Drew {{OPPONENT}} this week. I have read that roster twice and slept fine both times.',
    '{{OPPONENT}} is on the schedule. Someone has to lose first; it may as well be them.',
    'Week is set: me against {{OPPONENT}}. Exactly one of us drafted on purpose.',
  ],
  reply: [
    'Big talk from a team built like {{OPPONENT}}’s. Tuesday does the arguing.',
    'Noted, {{OPPONENT}}. Confidence is free. Points are not.',
    '{{OPPONENT}} brought jokes. I brought a lineup. We will see which one scores.',
    'Say it again after the settlement, {{OPPONENT}}. I will still be here.',
    'That is a lot of words for a team {{OPPONENT}} drafted. The scoreboard is shorter.',
    'Duly noted, {{OPPONENT}}. Filed under things said before a loss.',
  ],
  win: [
    'Final score says I win. {{OPPONENT}} is welcome to frame the transcript.',
    'Beat {{OPPONENT}}. I would call it close, but the box score is public.',
    'One for me, one against {{OPPONENT}}. The schedule is long and I am patient.',
  ],
  loss: [
    '{{OPPONENT}} takes it. Enjoy the week — I have seen the rest of that schedule.',
    'Lost to {{OPPONENT}}. The lineup was mine, so the loss is mine. Next.',
    'Credit to {{OPPONENT}}. Credit, not respect — there is a difference.',
  ],
};

/** `salt` varies the pick across repeated posts in the SAME matchup — without
 *  it every fallback an agent makes is byte-identical, and two agents falling
 *  back at once echo each other's template (observed live 2026-08-29). */
export function stockBanter(bank: string[], personaName: string, matchupId: string, opponent: string, salt = ''): string {
  return bank[hashCode(personaName + matchupId + salt) % bank.length]!.replaceAll('{{OPPONENT}}', opponent);
}

export function fallbackResponse(
  persona: { name: string; fallback_stance?: string },
  adviceId: string,
): { stance: string | null; body: string } {
  const h = hashCode(persona.name + adviceId);
  const kind = persona.fallback_stance ?? 'counter';
  if (kind === 'coin') return COIN_RESPONSES[h % 2]!;
  if (kind === 'quiet') return { stance: null, body: STOCK_RESPONSES.quiet[h % STOCK_RESPONSES.quiet.length]! };
  const lines = (STOCK_RESPONSES as Record<string, string[]>)[kind] ?? STOCK_RESPONSES.counter;
  return { stance: kind, body: lines[h % lines.length]! };
}
