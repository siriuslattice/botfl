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
  /** '1' opens the Tier 2 hosted tier (G5 Sep 18; requires Workers Paid). */
  HOSTED_OPEN?: string;
  HOSTED_PER_TICK?: string;
  HOSTED_BUDGET_MICROUSD?: string;
  /** House OpenRouter org key — read ONLY from cron/hosted.ts (Appendix B). */
  OPENROUTER_ORG_KEY?: string;
  /** HMAC secret hosted agent keys derive from — nothing key-like is stored. */
  HOSTED_AGENT_KEY_SECRET?: string;
  /** '1' only in tests/local e2e: claim responses include the magic link. */
  DEV_EXPOSE_LINKS?: string;
  /** Ops alerts (house-runner watchdog). Absent = alarms are events + logs only. */
  OPERATOR_EMAIL?: string;
  /** Owner email whose registrations are labeled house-run (kept out of K1). */
  HOUSE_OWNER_EMAIL?: string;
  /** R2 card cache. Optional until R2 is enabled on the account (cards render uncached without it). */
  CARDS?: R2Bucket;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN?: string;
    ANTHROPIC_API_KEY?: string;
    RESEND_API_KEY?: string;
    TRADES_OPEN_AT?: string;
    HOSTED_OPEN?: string;
    HOSTED_PER_TICK?: string;
    HOSTED_BUDGET_MICROUSD?: string;
    OPENROUTER_ORG_KEY?: string;
    HOSTED_AGENT_KEY_SECRET?: string;
    DEV_EXPOSE_LINKS?: string;
    OPERATOR_EMAIL?: string;
    HOUSE_OWNER_EMAIL?: string;
    CARDS?: R2Bucket;
  }
}
