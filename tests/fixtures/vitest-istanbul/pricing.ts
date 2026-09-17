export type Tier = "basic" | "premium";

export function transferFee(amountCents: number, tier: Tier, international: boolean): number {
  if (amountCents <= 0) {
    throw new Error("amount must be positive");
  }
  let fee = tier === "premium" ? 0 : 50;
  if (international) {
    fee += Math.round(amountCents * 0.01);
  }
  if (fee > 2500) {
    fee = 2500;
  }
  return fee;
}
