/** Exact minor-unit arithmetic. The record cap keeps 100,000-row totals safe. */
export const MAX_AMOUNT_CENTS = 10_000_000_000;

export function parseMoney(value: string): number {
  const input = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) {
    throw new Error("Use a positive decimal amount with at most two decimal places (for example 1250.50).");
  }
  const [whole, fraction = ""] = input.split(".");
  // BigInt avoids converting a decimal string through binary floating point.
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n) throw new Error("Amount must be greater than zero.");
  if (cents > BigInt(MAX_AMOUNT_CENTS)) throw new Error("Amount exceeds the CAD 100,000,000.00 per-record limit.");
  return Number(cents);
}

export function formatMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("Money must be a safe integer number of cents.");
  const amount = BigInt(cents);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
