import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // At least 32 characters: shorter secrets are refused.
            BOT_TOKEN: "test-bot-token-0123456789abcdef0123",
            INBOX_SECRET: "test-inbox-secret-0123456789abcdef0123",
            // Override whatever a local .dev.vars sets; tests pass these per call.
            FORWARD_WEBHOOK_URL: "",
            FORWARD_WEBHOOK_KEY: "",
            FORWARD_SIGNING_SECRET: "",
            CANONICAL_BOTS: "",
            TEST_MIGRATIONS: migrations,
          },
          // An empty database for testing a migration against older rows.
          d1Databases: { MIGRATION_DB: "migration-test" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
