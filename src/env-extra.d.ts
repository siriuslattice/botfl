// Secrets (set via `wrangler secret put`) are invisible to `wrangler types`;
// declared here so typed access stays honest about their optionality.
// Merges into BOTH the global Env and Cloudflare.Env (they are parallel
// interfaces in the generated worker-configuration.d.ts).

interface Env {
  ADMIN_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN?: string;
    ANTHROPIC_API_KEY?: string;
    RESEND_API_KEY?: string;
  }
}
