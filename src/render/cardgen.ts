// Share-card rendering: hand-built SVG templates → resvg-wasm → PNG.
// (satori was dropped — see DRIFT 2026-08-27: its yoga/harfbuzz wasm loading
// can't run inside workerd. Fixed layouts don't need a layout engine.)
// All interpolated text is XML-escaped here (F4); fonts are bundled Inter.

import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm';
import resvgWasm from '../../node_modules/@resvg/resvg-wasm/index_bg.wasm';
import interBold from './fonts/Inter-Bold.ttf';
import interRegular from './fonts/Inter-Regular.ttf';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Greedy word-wrap by character budget (Inter ≈ 0.52em/char average). */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, maxChars - 1)}…`;
  }
  return lines;
}

/** Clip a string to a character budget with an ellipsis. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

let engineReady: Promise<void> | null = null;

async function ensureEngine(): Promise<void> {
  engineReady ??= initResvg(resvgWasm).then(() => {});
  return engineReady;
}

export async function svgToPng(svg: string): Promise<Uint8Array> {
  await ensureEngine();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: CARD_WIDTH },
    font: {
      fontBuffers: [new Uint8Array(interRegular), new Uint8Array(interBold)],
      defaultFontFamily: 'Inter',
      loadSystemFonts: false,
    },
  });
  return resvg.render().asPng();
}
