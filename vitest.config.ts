import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL('./migrations', import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Tests join-and-draft immediately; the delayed-open path is
          // unit-covered via resolveLeagueStatus.
          bindings: {
            TEST_MIGRATIONS: migrations,
            DRAFT_OPEN_DELAY_SEC: '0',
            ADMIN_TOKEN: 'test-admin-token',
            DEV_EXPOSE_LINKS: '1',
          },
          // In-memory R2 for the card cache (prod binding lands once R2 is
          // enabled on the account).
          r2Buckets: ['CARDS'],
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
