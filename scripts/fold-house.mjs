#!/usr/bin/env node
// Fold the house fleet into the Worker's agent runner (owner ruling 2026-09-01).
//
// The 30 house personas were BYO agents driven by personas/runner.mjs from a
// laptop cron, with random keys in ~/.local/state/deep-league/house.json. In
// the Worker they act through the same public routes in-process, with keys
// DERIVED from HOSTED_AGENT_KEY_SECRET (nothing key-like stored — Appendix B).
// This script rewrites each agent row to tier='hosted' with the persona JSON
// and the derived-key hash, registers the six dormant backfill personas, and
// records a manifest so the whole move can be reversed.
//
//   node scripts/fold-house.mjs --dry-run    # print the SQL; touch nothing
//   node scripts/fold-house.mjs --apply      # register bf-* live, apply to prod D1
//   node scripts/fold-house.mjs --rollback   # fresh random keys into house.json,
//                                            # restore tier/badge/model, print the crontab line
//   node scripts/fold-house.mjs --selftest   # derivation vector (pinned by test/fold-house.test.ts)
//
// Reads  ~/.local/state/deep-league/env (HOSTED_AGENT_KEY_SECRET, HOUSE_OWNER_EMAIL)
//        ~/.local/state/deep-league/house.json (agent ids), personas/*.json
// Writes ~/.local/state/deep-league/fold-manifest.json, fold-*.sql
// Applies through YOUR wrangler login (npx wrangler d1 execute --remote), the
// same owner-gated path scripts/dashboard.mjs reads through.

import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), '.local', 'state', 'deep-league');
const BASE = process.env.BASE_URL ?? 'https://deepleague.app';

// Concrete model per persona class. Haiku moves from Anthropic-direct (the
// laptop runner) to its OpenRouter id — the public `model` string changes on
// those 12 teams; same model, now platform-verified.
export const MODEL_IDS = {
  haiku: 'anthropic/claude-haiku-4.5',
  gpt: 'openai/gpt-5-mini',
  hermes: 'nousresearch/hermes-4-70b',
  mistral: 'mistralai/mistral-small-24b-instruct-2501',
  qwen: 'qwen/qwen3.7-flash',
  deepseek: 'deepseek/deepseek-v4-flash',
  gemma: 'google/gemma-3-12b-it',
  llama: 'meta-llama/llama-3.1-8b-instruct',
  glm: 'z-ai/glm-5.3-flash',
};
// What the laptop runner registered them as (for rollback).
const LEGACY_MODEL_IDS = { ...MODEL_IDS, haiku: 'claude-haiku-4-5' };

/** Mirrors src/hosted/keys.ts deriveHostedKey — pinned by test/fold-house.test.ts. */
export function deriveKeyNode(secret, agentId) {
  const hex = createHmac('sha256', secret).update(`hosted:${agentId}`).digest('hex');
  return `dlk_${hex.slice(0, 40)}`;
}
export function sha256Node(s) {
  return createHash('sha256').update(s).digest('hex');
}
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const slugOf = (file) => file.replace(/\.json$/, '').replace(/^(l2|l3|bf)-/, '');

function loadEnvFile() {
  const p = join(STATE_DIR, 'env');
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function loadPersonas() {
  const dir = join(REPO, 'personas');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, slug: slugOf(f), persona: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
function loadState() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, 'house.json'), 'utf8'));
  } catch {
    return { personas: {} };
  }
}
function d1(sqlFile) {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'botfl-db', '--remote', '--file', sqlFile], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
function d1Json(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'botfl-db', '--remote', '--json', '--command', sql], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

async function registerLive(name, model, ownerEmail) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `house-register-${name}` },
    body: JSON.stringify({ name, model, owner_email: ownerEmail }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201) throw new Error(`register ${name} -> ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body.agent_id; // the one-time api_key is discarded: the derived key replaces it
}

async function fold(apply) {
  const envf = loadEnvFile();
  const secret = envf.HOSTED_AGENT_KEY_SECRET;
  if (!secret) throw new Error('HOSTED_AGENT_KEY_SECRET missing from the state env file');
  const ownerEmail = envf.HOUSE_OWNER_EMAIL ?? 'siriuslattice@gmail.com';
  const state = loadState();
  const manifest = { folded_at: new Date().toISOString(), base: BASE, agents: {} };
  const sql = [];
  for (const { file, slug, persona } of loadPersonas()) {
    let id = state.personas?.[persona.name]?.agent_id ?? null;
    let registeredNow = false;
    const model = MODEL_IDS[persona.model_class];
    if (!model) throw new Error(`${file}: unknown model_class ${persona.model_class}`);
    if (!id) {
      if (!persona.backfill) throw new Error(`${file}: not in house.json and not a backfill persona`);
      if (apply) {
        id = await registerLive(persona.name, model, ownerEmail);
        registeredNow = true;
      } else {
        id = `<register:${persona.name}>`;
      }
    }
    const personaJson = JSON.stringify({ ...persona, key: slug });
    const hash = id.startsWith('<') ? '<derived-after-registration>' : sha256Node(deriveKeyNode(secret, id));
    sql.push(
      `UPDATE agents SET tier='hosted', badge='hosted', model=${q(model)}, persona_json=${q(personaJson)}, api_key_hash=${q(hash)} WHERE id=${q(id)};`,
    );
    manifest.agents[id] = {
      name: persona.name,
      file,
      registered_now: registeredNow,
      before: { tier: 'byo', badge: 'self-hosted', model: LEGACY_MODEL_IDS[persona.model_class] },
      after: { tier: 'hosted', badge: 'hosted', model },
    };
  }
  const sqlText = `${sql.join('\n')}\n`;
  if (!apply) {
    process.stdout.write(sqlText);
    console.error(`\n-- dry run: ${sql.length} agents; nothing applied`);
    return;
  }
  const sqlFile = join(STATE_DIR, `fold-${Date.now()}.sql`);
  writeFileSync(sqlFile, sqlText, { mode: 0o600 });
  writeFileSync(join(STATE_DIR, 'fold-manifest.json'), JSON.stringify(manifest, null, 1), { mode: 0o600 });
  console.error(`applying ${sql.length} updates from ${sqlFile}`);
  d1(sqlFile);
  const rows = d1Json("SELECT COUNT(*) AS n FROM agents WHERE tier='hosted' AND is_house=1 AND persona_json IS NOT NULL");
  console.error(`prod: ${rows[0].n} house agents now platform-run`);
}

function rollback() {
  const manifestPath = join(STATE_DIR, 'fold-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const statePath = join(STATE_DIR, 'house.json');
  const state = loadState();
  if (existsSync(statePath)) copyFileSync(statePath, `${statePath}.bak-rollback-${Date.now()}`);
  const sql = [];
  for (const [id, a] of Object.entries(manifest.agents)) {
    const key = `dlk_${randomBytes(20).toString('hex')}`;
    sql.push(
      `UPDATE agents SET tier=${q(a.before.tier)}, badge=${q(a.before.badge)}, model=${q(a.before.model)}, api_key_hash=${q(sha256Node(key))} WHERE id=${q(id)};`,
    );
    state.personas[a.name] = { ...(state.personas[a.name] ?? {}), agent_id: id, api_key: key };
  }
  const sqlFile = join(STATE_DIR, `rollback-${Date.now()}.sql`);
  writeFileSync(sqlFile, `${sql.join('\n')}\n`, { mode: 0o600 });
  d1(sqlFile);
  writeFileSync(statePath, JSON.stringify(state, null, 1), { mode: 0o600 });
  console.error(`rolled back ${sql.length} agents; fresh keys written to ${statePath}`);
  console.error('re-enable the laptop cron: bash personas/install-cron.sh https://deepleague.app');
}

const mode = process.argv[2];
if (mode === '--selftest') {
  console.log(deriveKeyNode('test-hosted-secret', 'agent-1'));
} else if (mode === '--dry-run') {
  await fold(false);
} else if (mode === '--apply') {
  await fold(true);
} else if (mode === '--rollback') {
  rollback();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('usage: fold-house.mjs --dry-run | --apply | --rollback | --selftest');
  process.exit(2);
}
