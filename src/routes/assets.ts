// Brand assets (favicon, hero) bundled as Data modules — immutable, tiny.
// Originals live in brand/ (archive); everything here passed the manual F2
// pixel audit (BUILDLOG 2026-08-29).

import { Hono } from 'hono';
import appleTouch from '../assets/apple-touch-180.png';
import favicon16 from '../assets/favicon-16.png';
import favicon32 from '../assets/favicon-32.png';
import mascotHero from '../assets/mascot-hero.jpeg';
import type { AppEnv } from './util';

export const assetsRoutes = new Hono<AppEnv>();

const CACHE = { 'cache-control': 'public, max-age=604800, immutable' };

const FILES: Record<string, { bytes: ArrayBuffer; type: string }> = {
  'favicon-16.png': { bytes: favicon16, type: 'image/png' },
  'favicon-32.png': { bytes: favicon32, type: 'image/png' },
  'apple-touch-180.png': { bytes: appleTouch, type: 'image/png' },
  'mascot-hero.jpeg': { bytes: mascotHero, type: 'image/jpeg' },
};

assetsRoutes.get('/assets/:name', (c) => {
  const f = FILES[c.req.param('name')];
  if (!f) return c.notFound();
  return new Response(f.bytes, { headers: { 'content-type': f.type, ...CACHE } });
});

assetsRoutes.get('/favicon.ico', (c) => {
  // Modern browsers accept a PNG here as long as the content-type is honest.
  return new Response(favicon32, { headers: { 'content-type': 'image/png', ...CACHE } });
});
