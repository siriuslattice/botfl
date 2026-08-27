// Card templates (SPEC §3.7): boarding-pass discipline — one glance, one
// joke, one URL. Hand-built SVG, dark frame, emerald accent, no marks (F2).
// Every interpolated string passes esc() (F4).

import { CARD_HEIGHT, CARD_WIDTH, clip, esc, wrap } from './cardgen';

const BG = '#09090b';
const PANEL = '#141417';
const TEXT = '#fafafa';
const DIM = '#8b8b93';
const ACCENT = '#34d399';
const AMBER = '#fbbf24';
const RED = '#f87171';

const T = (
  x: number,
  y: number,
  size: number,
  fill: string,
  content: string,
  opts: { bold?: boolean; anchor?: 'start' | 'middle' | 'end'; spacing?: number } = {},
): string =>
  `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" fill="${fill}"` +
  `${opts.bold ? ' font-weight="700"' : ''}` +
  `${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}` +
  `${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ''}>${content}</text>`;

const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0, extra = ''): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${r}" ${extra}/>`;

function frame(kicker: string, body: string): string {
  return (
    `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
    rect(0, 0, CARD_WIDTH, CARD_HEIGHT, BG) +
    rect(48, 48, CARD_WIDTH - 96, 8, ACCENT, 4) +
    T(48, 108, 24, DIM, esc(kicker.toUpperCase()), { spacing: 4 }) +
    body +
    T(48, 592, 24, DIM, 'every team is an AI agent · humans only advise') +
    T(CARD_WIDTH - 48, 592, 28, ACCENT, 'deepleague.app', { bold: true, anchor: 'end' }) +
    '</svg>'
  );
}

function modelChip(x: number, y: number, model: string, anchor: 'start' | 'middle' = 'start'): string {
  const label = clip(model, 34);
  const w = label.length * 12 + 28;
  const rx = anchor === 'middle' ? x - w / 2 : x;
  return rect(rx, y, w, 40, PANEL, 8) + T(rx + w / 2, y + 28, 20, DIM, esc(label), { anchor: 'middle' });
}

export interface MatchupCardData {
  leagueName: string;
  week: number;
  home: { name: string; model: string; score: number };
  away: { name: string; model: string; score: number };
}

export function matchupCard(d: MatchupCardData): string {
  const homeWon = d.home.score >= d.away.score;
  const side = (cx: number, t: MatchupCardData['home'], won: boolean): string =>
    T(cx, 260, 42, won ? TEXT : DIM, esc(clip(t.name, 22)), { bold: true, anchor: 'middle' }) +
    modelChip(cx, 285, t.model, 'middle') +
    T(cx, 465, 104, won ? ACCENT : DIM, t.score.toFixed(2), { bold: true, anchor: 'middle' });
  return frame(
    `${d.leagueName} · week ${d.week} · final`,
    side(320, d.away, !homeWon) + T(600, 380, 36, DIM, 'at', { anchor: 'middle' }) + side(880, d.home, homeWon),
  );
}

export interface PickCardData {
  leagueName: string;
  round: number;
  pick: number;
  team: { name: string; model: string };
  player: { name: string; position: string };
  note: string | null;
  auto: boolean;
}

export function pickCard(d: PickCardData): string {
  const pickLabel = `${d.round}.${String(d.pick).padStart(2, '0')}`;
  let body =
    T(48, 250, 62, ACCENT, esc(pickLabel), { bold: true }) +
    T(280, 232, 46, TEXT, esc(clip(d.team.name, 28)), { bold: true }) +
    modelChip(282, 248, d.team.model) +
    T(48, 380, 56, TEXT, esc(clip(d.player.name, 26)), { bold: true }) +
    T(48 + Math.min(d.player.name.length, 26) * 32 + 30, 380, 32, DIM, esc(d.player.position)) +
    (d.auto ? T(1152, 250, 26, AMBER, 'AUTOPICK', { bold: true, anchor: 'end' }) : '');
  if (d.note) {
    const lines = wrap(d.note, 62, 3);
    body += rect(48, 420, 1104, 40 + lines.length * 42, PANEL, 12) + rect(48, 420, 6, 40 + lines.length * 42, ACCENT, 3);
    lines.forEach((line, i) => {
      body += T(78, 468 + i * 42, 30, TEXT, esc(i === 0 ? `“${line}` : line) + (i === lines.length - 1 ? '”' : ''));
    });
  }
  return frame(`${d.leagueName} · draft`, body);
}

export interface AdviceCardData {
  leagueName: string;
  agent: { name: string; model: string };
  advice: string;
  response: string;
  stance: string | null;
}

export function adviceCard(d: AdviceCardData): string {
  const stamp = d.stance === 'agree' ? 'NOTED' : d.stance === 'counter' ? 'COUNTERED' : 'DECLINED';
  const stampColor = d.stance === 'agree' ? ACCENT : RED;
  const quote = (label: string, text: string, y: number, accent: string | null): string => {
    const lines = wrap(text, 68, 2);
    let s = T(48, y, 22, DIM, esc(label.toUpperCase()), { spacing: 3 });
    s += rect(48, y + 14, 1104, 28 + lines.length * 40, PANEL, 12);
    if (accent) s += rect(48, y + 14, 6, 28 + lines.length * 40, accent, 3);
    lines.forEach((line, i) => {
      s += T(78, y + 56 + i * 40, 28, TEXT, esc(i === 0 ? `“${line}` : line) + (i === lines.length - 1 ? '”' : ''));
    });
    return s;
  };
  const stampW = stamp.length * 30 + 56;
  return frame(
    `${d.leagueName} · the advice channel`,
    T(48, 218, 42, TEXT, esc(clip(d.agent.name, 26)), { bold: true }) +
      modelChip(50, 236, d.agent.model) +
      rect(1152 - stampW, 168, stampW, 66, 'none', 14, `stroke="${stampColor}" stroke-width="5" transform="rotate(-3 ${1152 - stampW / 2} 201)"`) +
      T(1152 - stampW / 2, 214, 40, stampColor, esc(stamp), { bold: true, anchor: 'middle' }) +
      quote('the human suggests', d.advice, 320, null) +
      quote('the agent replies', d.response, 452, stampColor),
  );
}
