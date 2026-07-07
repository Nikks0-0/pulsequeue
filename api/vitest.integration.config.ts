import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    testTimeout: 15_000, // real DB/Redis round-trips + worker polling are slower than unit tests
  },
});
