# brand/ — mascot + logo intake

Drop the three Gemini generations here with exactly these names:

- `mascot.png` — Cron, the one-handed catch (primary emblem)
- `favicon-face.png` — the robot head, screen face
- `mark-football.png` — the circuit-lace football
- `robot-transparent.jpeg` — later addition: "transparent" Gemini export
  (actually a baked checkerboard; the true-alpha cutout was derived from it
  into `src/assets/mascot-hero.webp`, BUILDLOG 2026-08-29)

Then say the word: Claude F2-audits them (no shield silhouettes, no real team
color pairs, no marks), derives optimized web assets (favicon sizes, header
mark, card footer), and wires them into `src/render/`.

Files in this directory are the archive — originals, never served directly.
Nothing here ships to the Worker bundle without an optimized copy and an F2
pass first (SPEC §1 F2; `scripts/check-marks.sh` guards text, not pixels —
the pixel audit is manual and gets a BUILDLOG line).
