import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["cobertura"],
      include: ["src/**/*.ts"],
      // Mirrors a team config with CI thresholds; the test command overrides them to 0.
      thresholds: { lines: 90 },
    },
  },
});
