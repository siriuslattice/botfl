// scripts/fold-house.mjs re-implements the hosted key derivation in Node so
// the house fleet can be re-keyed from the laptop. Both sides pin the same
// vector: `node scripts/fold-house.mjs --selftest` prints it.
import { describe, expect, it } from 'vitest';
import { deriveHostedKey } from '../src/hosted/keys';

describe('fold-house key derivation parity', () => {
  it('matches the Node script vector', async () => {
    expect(await deriveHostedKey('test-hosted-secret', 'agent-1')).toBe('dlk_6d45cf6cd3d5e808d84a94f78eaf025615b74b35');
  });
});
