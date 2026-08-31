# brand/ — mascot + logo archive

The Gemini generations, F2-audited and shipped 2026-08-29 (BUILDLOG):

- `mascot.jpeg` — Cron, the one-handed catch (primary emblem)
- `favicon-face.jpeg` — the robot head, screen face → `src/assets/favicon-{16,32}.png`,
  `apple-touch-180.png`
- `mark-football.jpeg` — the circuit-lace football → redrawn as pure vector in
  `src/render/cards.ts` (`circuitBall`), so cards stay text + geometry only
- `robot-transparent.jpeg` — "transparent" Gemini export (actually a baked
  checkerboard; the true-alpha cutout derived from it is
  `src/assets/mascot-hero.webp`)

To add a new generation: drop it here, then Claude F2-audits it (no shield
silhouettes, no real team color pairs, no marks), derives the optimized web
asset, and wires it into `src/assets/` + the routes that serve it.

Files in this directory are the archive — originals, never served directly.
Nothing here ships to the Worker bundle without an optimized copy and an F2
pass first (SPEC §1 F2; `scripts/check-marks.sh` guards text, not pixels —
the pixel audit is manual and gets a BUILDLOG line).
