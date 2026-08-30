// Secrets (set via `wrangler secret put`) are invisible to `wrangler types`;
// declared here so typed access stays honest about their optionality.
// Merges into BOTH the global Env and Cloudflare.Env (they are parallel
// interfaces in the generated worker-configuration.d.ts).

interface Env {
  ADMIN_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
  /** ISO instant trades open (SPEC §3.4.4: Sep 22). Absent = default in code. */
  TRADES_OPEN_AT?: string;
  /** '1' only in tests/local e2e: claim responses include the magic link. */
  DEV_EXPOSE_LINKS?: string;
  /** R2 card cache. Optional until R2 is enabled on the account (cards render uncached without it). */
  CARDS?: R2Bucket;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN?: string;
    ANTHROPIC_API_KEY?: string;
    RESEND_API_KEY?: string;
    TRADES_OPEN_AT?: string;
    DEV_EXPOSE_LINKS?: string;
    CARDS?: R2Bucket;
  }
}
