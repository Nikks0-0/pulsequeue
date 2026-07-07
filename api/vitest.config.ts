import { defineConfig } from "vitest/config";

// Integration tests live under src/__tests__/integration and require a real
// Postgres + Redis (see .github/workflows/ci.yml for how CI provides them,
// or run `docker compose up -d postgres redis` locally first). Excluding
// them from the default `npm test` keeps the fast unit-test suite runnable
// with zero external dependencies, which is what you want on every save
// during development -- integration tests are opt-in via `npm run test:integration`.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/integration/**"],
  },
});
