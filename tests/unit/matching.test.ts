import { describe, expect, it } from "vitest";
import { generateFixture, generateSmallFixture } from "../../src/domain/fixtures";
import { type Invoice, normalizeReference, type Payment, reconcile, RULE_VERSION } from "../../src/domain/matching";

const makeInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: "INV-12", customerId: "C1", invoiceDate: "2026-09-01", dueDate: "2026-09-30",
  amount: 10_000, paid: 0, currency: "CAD", ...overrides,
});
const makePayment = (overrides: Partial<Payment> = {}): Payment => ({
  id: "PAY-1", customerId: "C1", paymentDate: "2026-09-10", amount: 10_000,
  currency: "CAD", reference: "INV-12", ...overrides,
});

describe("reference resolution", () => {
  it("normalizes case, outer whitespace and Unicode compatibility without deleting separators", () => {
    expect(normalizeReference("  inv-１２  ")).toBe("INV-12");
    expect(normalizeReference("inv_12")).toBe("INV_12");
    expect(reconcile([makeInvoice()], [makePayment({ reference: "Paid: (inv-12), thank you" })]).allocations[0].invoiceId).toBe("INV-12");
  });
  it.each(["INV-123", "INV-12-A", "PREFIX-INV-12", "INV-12X", "INV-12.3", "INV-12/3", "INV-12+3"])(
    "does not substring-match %s to INV-12", (reference) => {
      const result = reconcile([makeInvoice()], [makePayment({ reference })]);
      expect(result.allocations).toEqual([]);
      expect(result.reviews[0].status).toBe("unknown_reference");
    },
  );
  it("selects INV-123 when both INV-12 and INV-123 exist", () => {
    const result = reconcile([makeInvoice(), makeInvoice({ id: "INV-123" })], [makePayment({ reference: "INV-123" })]);
    expect(result.allocations.map((entry) => entry.invoiceId)).toEqual(["INV-123"]);
  });
  it("requires review for a normalized identifier collision", () => {
    const result = reconcile([makeInvoice(), makeInvoice({ id: "inv-12" })], [makePayment()]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0].status).toBe("ambiguous_reference");
  });
  it("requires review when the reference names two invoices even if only one amount fits", () => {
    const result = reconcile([makeInvoice(), makeInvoice({ id: "INV-13", amount: 500 })], [makePayment({ reference: "INV-12, INV-13" })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0].status).toBe("ambiguous_reference");
  });
  it("treats repeated mentions of the same invoice as one reference", () => {
    expect(reconcile([makeInvoice()], [makePayment({ reference: "INV-12; INV-12" })]).allocations).toHaveLength(1);
  });
});

describe("conservative precedence and monetary behavior", () => {
  it("stores rule version, explanation and exact before/after evidence", () => {
    const result = reconcile([makeInvoice()], [makePayment()]);
    expect(result.reviews).toEqual([]);
    expect(result.allocations[0]).toMatchObject({
      paymentId: "PAY-1", invoiceId: "INV-12", amount: 10_000,
      evidence: { ruleVersion: RULE_VERSION, outstandingBefore: 10_000, outstandingAfter: 0, paymentAmount: 10_000, customerMatched: true, currency: "CAD" },
    });
    expect(result.allocations[0].explanation).toContain("fully paid");
  });
  it("accepts an explicit reference when no customer ID was supplied", () => {
    expect(reconcile([makeInvoice()], [makePayment({ customerId: null })]).allocations).toHaveLength(1);
  });
  it("checks currency before customer mismatch", () => {
    const result = reconcile([makeInvoice()], [makePayment({ currency: "USD", customerId: "OTHER" })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0].status).toBe("currency_mismatch");
  });
  it("checks customer identity before balance suitability", () => {
    const result = reconcile([makeInvoice()], [makePayment({ customerId: "OTHER", amount: 20_000 })]);
    expect(result.reviews[0].status).toBe("customer_mismatch");
    expect(result.reviews[0].candidates).toEqual([]);
  });
  it("combines sequential partial payments and refuses a later overpayment", () => {
    const result = reconcile([makeInvoice()], [
      makePayment({ id: "P3", paymentDate: "2026-09-03", amount: 7_001 }),
      makePayment({ id: "P2", paymentDate: "2026-09-02", amount: 5_000 }),
      makePayment({ id: "P1", paymentDate: "2026-09-01", amount: 3_000 }),
      makePayment({ id: "P4", paymentDate: "2026-09-04", amount: 2_000 }),
    ]);
    expect(result.allocations.map((entry) => [entry.paymentId, entry.evidence.outstandingAfter])).toEqual([["P1", 7_000], ["P2", 2_000], ["P4", 0]]);
    expect(result.reviews).toMatchObject([{ paymentId: "P3", status: "overpayment" }]);
    expect(result.allocations.reduce((total, entry) => total + entry.amount, 0)).toBe(10_000);
  });
  it("respects existing active allocations when computing the remaining balance", () => {
    const result = reconcile([makeInvoice({ paid: 8_000 })], [makePayment({ amount: 2_001 })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0].status).toBe("overpayment");
    expect(result.reviews[0].explanation).toContain("20.00");
  });
  it("distinguishes a fully paid invoice from an overpayment", () => {
    expect(reconcile([makeInvoice({ paid: 10_000 })], [makePayment()]).reviews[0].status).toBe("invoice_paid");
  });
  it("does not allocate a reference-free payment even with exactly one exact candidate", () => {
    const result = reconcile([makeInvoice()], [makePayment({ reference: null })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0]).toMatchObject({ status: "needs_review", candidates: [{ invoiceId: "INV-12" }] });
  });
  it("ranks exact balances above partial candidates and identifies ambiguity", () => {
    const result = reconcile([makeInvoice({ amount: 12_000 }), makeInvoice({ id: "INV-13" })], [makePayment({ reference: null })]);
    expect(result.reviews[0].status).toBe("ambiguous");
    expect(result.reviews[0].candidates.map((candidate) => candidate.invoiceId)).toEqual(["INV-13", "INV-12"]);
    expect(result.reviews[0].candidates[0].score).toBeGreaterThan(result.reviews[0].candidates[1].score);
  });
  it("does not suggest an invoice that a later payment settles during the same run", () => {
    const result = reconcile([makeInvoice()], [
      makePayment({ id: "P1", reference: null, paymentDate: "2026-09-01" }),
      makePayment({ id: "P2", paymentDate: "2026-09-02" }),
    ]);
    expect(result.allocations).toHaveLength(1);
    expect(result.reviews[0].candidates).toEqual([]);
  });
  it("keeps invoice paid status independent from a payment's review status", () => {
    const result = reconcile([makeInvoice({ paid: 2_000 })], [makePayment({ amount: 4_000, reviewStatus: "needs_review" })]);
    expect(result.allocations[0].evidence.outstandingAfter).toBe(4_000);
  });
  it.each(["reversed", "deferred"])("requires deliberate reviewer action for a %s payment", (reviewStatus) => {
    const result = reconcile([makeInvoice()], [makePayment({ reviewStatus })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews[0].status).toBe(reviewStatus);
    expect(result.reviews[0].candidates[0].invoiceId).toBe("INV-12");
  });
});

describe("duplicates, deterministic ordering and reruns", () => {
  it("flags both suspicious payments before either receives an allocation", () => {
    const result = reconcile([makeInvoice()], [makePayment({ id: "P2", reference: " inv-12 " }), makePayment({ id: "P1" })]);
    expect(result.allocations).toEqual([]);
    expect(result.reviews.map((entry) => [entry.paymentId, entry.status])).toEqual([["P1", "suspected_duplicate"], ["P2", "suspected_duplicate"]]);
  });
  it("applies duplicate checks before reference, customer and amount checks", () => {
    const duplicate = makePayment({ customerId: "OTHER", reference: "UNKNOWN", amount: 20_000 });
    const result = reconcile([makeInvoice()], [duplicate, { ...duplicate, id: "P2" }]);
    expect(result.reviews.every((entry) => entry.status === "suspected_duplicate")).toBe(true);
  });
  it("detects a suspicious new payment even when its twin was previously allocated", () => {
    const result = reconcile([makeInvoice({ paid: 10_000 })], [makePayment({ id: "P1" }), makePayment({ id: "P2" })], new Set(["P1"]));
    expect(result.allocations).toEqual([]);
    expect(result.reviews).toMatchObject([{ paymentId: "P2", status: "suspected_duplicate" }]);
  });
  it("uses date first then code-point ID order, independent of array order", () => {
    const invoices = [makeInvoice(), makeInvoice({ id: "INV-99" })];
    const payments = [
      makePayment({ id: "P-Z", amount: 6_000, paymentDate: "2026-09-01" }),
      makePayment({ id: "P-A", amount: 5_000, paymentDate: "2026-09-01" }),
      makePayment({ id: "P-B", amount: 5_000, paymentDate: "2026-09-02" }),
    ];
    const expected = reconcile(invoices, payments);
    expect(expected.allocations.map((entry) => entry.paymentId)).toEqual(["P-A", "P-B"]);
    expect(reconcile([...invoices].reverse(), [...payments].reverse())).toEqual(expected);
  });
  it("preserves caller inputs and skips already allocated payment IDs", () => {
    const invoice = Object.freeze(makeInvoice());
    const payment = Object.freeze(makePayment());
    expect(reconcile([invoice], [payment]).allocations).toHaveLength(1);
    expect(invoice.paid).toBe(0);
    expect(reconcile([{ ...invoice, paid: 10_000 }], [payment], new Set([payment.id]))).toEqual({ allocations: [], reviews: [] });
  });
  it("rejects duplicate IDs or impossible cent balances at the pure-domain boundary", () => {
    expect(() => reconcile([makeInvoice(), makeInvoice()], [])).toThrow("Duplicate invoice ID");
    expect(() => reconcile([], [makePayment(), makePayment()])).toThrow("Duplicate payment ID");
    expect(() => reconcile([makeInvoice({ paid: 10_001 })], [])).toThrow("Invalid allocated total");
    expect(() => reconcile([makeInvoice({ amount: 0.5 })], [])).toThrow("integer amount");
  });
});

describe("independently labeled synthetic fixtures", () => {
  it("provides a hand-checkable ambiguous payment and partial-then-final sequence", () => {
    const fixture = generateSmallFixture();
    const result = reconcile(fixture.invoices, fixture.payments);
    expect(fixture.invoices).toHaveLength(12);
    expect(fixture.payments).toHaveLength(12);
    expect(result.allocations).toHaveLength(5);
    expect(result.reviews).toHaveLength(7);
    expect(result.reviews.find((entry) => entry.paymentId === "PAY-1001")?.candidates.map((entry) => entry.invoiceId)).toEqual(["INV-1001", "INV-1002"]);
    expect(result.allocations.filter((entry) => entry.invoiceId === "INV-1004").map((entry) => entry.amount)).toEqual([40_000, 60_000]);
  });
  it("reproduces fixture fields from a fixed seed while preserving independent labels", () => {
    expect(generateFixture(240, 42)).toEqual(generateFixture(240, 42));
    expect(generateFixture(240, 42).invoices).not.toEqual(generateFixture(240, 43).invoices);
    expect(generateFixture(240, 42).truth).toEqual(generateFixture(240, 43).truth);
  });
  it("satisfies independent eligible truth and accounting invariants at 1,000 invoices", () => {
    const fixture = generateFixture(1_000, 42);
    const result = reconcile(fixture.invoices, fixture.payments);
    const pairs = result.allocations.map(({ paymentId, invoiceId }) => `${paymentId}/${invoiceId}`).sort();
    expect(pairs).toEqual(fixture.truth.map(({ paymentId, invoiceId }) => `${paymentId}/${invoiceId}`).sort());
    expect(result.reviews.map((entry) => entry.paymentId).sort()).toEqual([...fixture.reviewPaymentIds].sort());
    expect(fixture.payments).toHaveLength(1_000);
    expect(new Set(result.allocations.map((entry) => entry.paymentId)).size).toBe(result.allocations.length);
    const allocated = result.allocations.reduce((total, entry) => total + entry.amount, 0);
    const invoiceTotal = fixture.invoices.reduce((total, entry) => total + entry.amount, 0);
    const paymentTotal = fixture.payments.reduce((total, entry) => total + entry.amount, 0);
    const paidByInvoice = new Map<string, number>();
    for (const entry of result.allocations) paidByInvoice.set(entry.invoiceId, (paidByInvoice.get(entry.invoiceId) ?? 0) + entry.amount);
    const balances = fixture.invoices.map((entry) => entry.amount - (paidByInvoice.get(entry.id) ?? 0));
    expect(balances.every((amount) => amount >= 0)).toBe(true);
    expect(allocated + balances.reduce((total, value) => total + value, 0)).toBe(invoiceTotal);
    const activePaymentIds = new Set(result.allocations.map((entry) => entry.paymentId));
    const unallocated = fixture.payments.filter((entry) => !activePaymentIds.has(entry.id)).reduce((total, entry) => total + entry.amount, 0);
    expect(allocated + unallocated).toBe(paymentTotal);
    expect(reconcile(fixture.invoices.map((entry) => ({ ...entry, paid: paidByInvoice.get(entry.id) ?? 0 })), fixture.payments, activePaymentIds).allocations).toEqual([]);
  });
});
