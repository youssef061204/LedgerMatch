import { describe, expect, it } from "vitest";
import { formatMoney, MAX_AMOUNT_CENTS, parseMoney } from "../../src/domain/money";

describe("exact minor-unit money", () => {
  it.each([["0.01", 1], ["0.29", 29], ["10", 1000], ["10.1", 1010], [" 1234.56 ", 123456], ["0001.05", 105], ["100000000.00", MAX_AMOUNT_CENTS]])(
    "parses %s exactly", (input, cents) => expect(parseMoney(input as string)).toBe(cents),
  );
  it.each(["", "0", "0.00", "-1", "+1", "1.001", "1.000", "1e2", "1,000.00", ".50", "1.", "NaN", "Infinity", "100000000.01", "9999999999999999999999"])(
    "rejects invalid or unsafe amount %s", (input) => expect(() => parseMoney(input)).toThrow(),
  );
  it("adds notoriously inexact decimals as exact integers", () => {
    expect(parseMoney("0.10") + parseMoney("0.20")).toBe(30);
  });
  it.each([[0, "0.00"], [1, "0.01"], [101, "1.01"], [-101, "-1.01"], [10000000000, "100000000.00"]])(
    "formats %s without a floating point conversion", (cents, display) => expect(formatMoney(cents as number)).toBe(display),
  );
  it("refuses fractional and unsafe cent values", () => {
    expect(() => formatMoney(1.5)).toThrow();
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
