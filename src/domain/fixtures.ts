import type { Invoice, Payment } from "./matching";

export interface SyntheticFixture {
  invoices: Invoice[];
  payments: Payment[];
  /** Independently authored unambiguous, automation-eligible payment/invoice pairs. */
  truth: { paymentId: string; invoiceId: string }[];
  reviewPaymentIds: string[];
}

function invoice(id: number, customerId: string, amount: number, day = 1): Invoice {
  return {
    id: `INV-${id}`, customerId, amount, currency: "CAD", paid: 0,
    invoiceDate: `2026-09-${String(day).padStart(2, "0")}`, dueDate: "2026-10-01",
  };
}

function payment(id: number, customerId: string | null, amount: number, reference: string | null, day = 10): Payment {
  return {
    id: `PAY-${id}`, customerId, amount, reference, currency: "CAD",
    paymentDate: `2026-09-${String(day).padStart(2, "0")}`,
  };
}

/** Twelve fictional invoices and payments; labels are written without invoking the matcher. */
export function generateSmallFixture(): SyntheticFixture {
  return {
    invoices: [
      invoice(1001, "CUST-MAPLE", 125_000),
      invoice(1002, "CUST-MAPLE", 125_000),
      invoice(1003, "CUST-BIRCH", 48_000),
      invoice(1004, "CUST-CEDAR", 100_000),
      invoice(1005, "CUST-ELM", 75_000),
      invoice(1006, "CUST-PINE", 180_000),
      invoice(1007, "CUST-WILLOW", 60_000),
      invoice(1008, "CUST-ASPEN", 90_000),
      invoice(1009, "CUST-SPRUCE", 30_000),
      invoice(1010, "CUST-RIVER", 55_000),
      invoice(1011, "CUST-HARBOR", 84_000),
      invoice(1012, "CUST-MEADOW", 36_000),
    ],
    payments: [
      payment(1001, "CUST-MAPLE", 125_000, null),
      payment(1003, "CUST-BIRCH", 48_000, "Remittance: inv-1003"),
      payment(1004, "CUST-CEDAR", 40_000, "INV-1004", 8),
      payment(1005, "CUST-CEDAR", 60_000, "INV-1004", 9),
      payment(1006, "CUST-ELM", 25_000, "INV-1005"),
      payment(1007, "CUST-WILLOW", 70_000, "INV-1007"),
      payment(1008, "CUST-OTHER", 90_000, "INV-1008"),
      payment(1009, "CUST-SPRUCE", 30_000, "INV-1009"),
      payment(1010, "CUST-SPRUCE", 30_000, "INV-1009"),
      payment(1011, "CUST-RIVER", 55_000, "INV-NOT-FOUND"),
      payment(1012, null, 84_000, "INV-1011"),
      payment(1013, null, 36_000, "INV-1010 INV-1012"),
    ],
    truth: [
      { paymentId: "PAY-1003", invoiceId: "INV-1003" },
      { paymentId: "PAY-1004", invoiceId: "INV-1004" },
      { paymentId: "PAY-1005", invoiceId: "INV-1004" },
      { paymentId: "PAY-1006", invoiceId: "INV-1005" },
      { paymentId: "PAY-1012", invoiceId: "INV-1011" },
    ],
    reviewPaymentIds: ["PAY-1001", "PAY-1007", "PAY-1008", "PAY-1009", "PAY-1010", "PAY-1011", "PAY-1013"],
  };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `size` is the invoice count. Common benchmark sizes also have `size` payments. */
export function generateFixture(size = 240, seed = 42): SyntheticFixture {
  if (!Number.isSafeInteger(size) || size < 12 || size > 1_000_000) {
    throw new Error("Fixture size must be an integer between 12 and 1,000,000 invoices.");
  }
  if (!Number.isSafeInteger(seed)) throw new Error("Fixture seed must be an integer.");
  const fixture = generateSmallFixture();
  const random = seededRandom(seed);
  let nextPayment = 1014;
  const add = (source: Invoice, amount: number, reference: string | null, eligible: boolean,
    customerId: string | null = source.customerId, date = 10) => {
    const entry = payment(nextPayment++, customerId, amount, reference, date);
    fixture.payments.push(entry);
    if (eligible) fixture.truth.push({ paymentId: entry.id, invoiceId: source.id });
    else fixture.reviewPaymentIds.push(entry.id);
  };
  for (let index = 0; index < size - 12; index++) {
    const amount = 10_000 + Math.floor(random() * 490_000);
    const source = invoice(1013 + index, `CUST-${String(Math.floor(index / 8) + 1).padStart(6, "0")}`, amount, 1 + Math.floor(random() * 5));
    fixture.invoices.push(source);
    const scenario = index % 20;
    if (scenario < 11) {
      add(source, amount, index % 3 === 0 ? `Wire for ${source.id.toLowerCase()}` : source.id, true);
    } else if (scenario === 11) {
      const first = Math.floor(amount * 2 / 5);
      add(source, first, source.id, true, source.customerId, 8);
      add(source, amount - first, source.id, true, source.customerId, 9);
    } else if (scenario === 12) {
      add(source, Math.floor(amount / 3), source.id, true);
    } else if (scenario === 13 || scenario === 14) {
      // Intentionally unpaid: no payment exists in the ground truth.
    } else if (scenario === 15) {
      add(source, amount, `UNKNOWN-${index}`, false);
    } else if (scenario === 16) {
      add(source, amount, source.id, false, "CUST-NOT-THE-CUSTOMER");
    } else if (scenario === 17) {
      add(source, amount + 5_000, source.id, false);
    } else if (scenario === 18) {
      add(source, amount, null, false);
    } else {
      add(source, amount, source.id, false);
      add(source, amount, source.id, false);
    }
  }
  return fixture;
}
