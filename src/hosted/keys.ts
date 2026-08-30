// Hosted-agent key custody (Appendix B: "API keys stored as hashes only").
// NOTHING key-like is stored: each hosted agent's key is derived on demand
// from a Worker secret + the agent id, and only its sha256 lands in
// api_key_hash — identical at-rest posture to every BYO agent. Rotating
// HOSTED_AGENT_KEY_SECRET orphans hosted hashes (runbook: re-hash sweep).

export async function deriveHostedKey(secret: string, agentId: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(`hosted:${agentId}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Same shape as newApiKey() — passes agentAuth's dlk_ prefix and length checks.
  return `dlk_${hex.slice(0, 40)}`;
}
