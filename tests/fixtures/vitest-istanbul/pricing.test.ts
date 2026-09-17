import { describe, expect, it } from "vitest";
import { transferFee } from "../src/pricing";

describe("transferFee", () => {
  it("charges the flat basic fee for domestic transfers", () => {
    expect(transferFee(10_000, "basic", false)).toBe(50);
  });
});
