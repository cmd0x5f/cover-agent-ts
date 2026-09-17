import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // The e2e test spawns a real Vitest process inside a fixture project.
    exclude: ["tests/fixtures/**", "node_modules/**"],
  },
});
