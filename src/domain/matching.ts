import { formatMoney, MAX_AMOUNT_CENTS } from "./money";

export const RULE_VERSION = "1.0.0";

export interface Invoice {
  id: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  amount: number;
  currency: string;
  /** Sum of active allocations, derived by the persistence layer. */
  paid: number;
}

export interface Payment {
  id: string;
  customerId: string | null;
  paymentDate: string;
  amount: number;
  currency: string;
  reference: string | null;
  reviewStatus?: string;
}

export interface Candidate {
  invoiceId: string;
  /** A heuristic ranking, never a probability. */
  score: number;
  reasons: string[];
}

export interface AllocationProposal {
  paymentId: string;
  invoiceId: string;
  amount: number;
  explanation: string;
  evidence: {
    ruleVersion: string;
    reference: string | null;
    normalizedReference: string;
    referencedInvoiceIds: string[];
    customerMatched: boolean;
    currency: string;
    paymentAmount: number;
    outstandingBefore: number;
    outstandingAfter: number;
    paymentOrder: string;
  };
}

export interface ReviewProposal {
  paymentId: string;
  status: string;
  explanation: string;
  candidates: Candidate[];
}

export interface ReconciliationResult {
  allocations: AllocationProposal[];
  reviews: ReviewProposal[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byInvoiceDate = (a: Invoice, b: Invoice) => compare(a.invoiceDate, b.invoiceDate) || compare(a.id, b.id);

/** Case and compatibility normalization only; separators are never discarded. */
export function normalizeReference(reference: string): string {
  return reference.normalize("NFKC").trim().toUpperCase();
}

/** Whole tokens prevent INV-12 from resolving to INV-123 or PREFIX-INV-12. */
export function referenceTokens(reference: string): string[] {
  return normalizeReference(reference).match(/[^\s,;:()[\]{}"'<>]+/gu) ?? [];
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const group = map.get(key);
  if (group) group.push(value);
  else map.set(key, [value]);
}

function nearby(invoices: Invoice[] | undefined, date: string, count = 48): Invoice[] {
  if (!invoices) return [];
  let low = 0;
  let high = invoices.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (invoices[middle].invoiceDate < date) low = middle + 1;
    else high = middle;
  }
  const start = Math.max(0, Math.min(invoices.length - count, low - Math.floor(count / 2)));
  return invoices.slice(start, start + count);
}

function validateAmount(amount: number, label: string) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
    throw new Error(`${label} must contain a positive, bounded integer amount in cents.`);
  }
}

/**
 * Pure deterministic proposals. Persistence must apply proposals in a transaction
 * with workspace locks and constraints; this function is not a concurrency guard.
 */
export function reconcile(
  invoices: Invoice[],
  payments: Payment[],
  allocatedPaymentIds: Set<string> = new Set(),
): ReconciliationResult {
  const invoiceIndex = new Map<string, Invoice[]>();
  const invoiceById = new Map<string, Invoice>();
  const outstanding = new Map<string, number>();
  const byCustomer = new Map<string, Invoice[]>();
  const byAmount = new Map<string, Invoice[]>();
  const byCustomerAmount = new Map<string, Invoice[]>();
  const key = (...parts: (string | number)[]) => JSON.stringify(parts);

  for (const invoice of invoices) {
    if (invoiceById.has(invoice.id)) throw new Error(`Duplicate invoice ID: ${invoice.id}`);
    validateAmount(invoice.amount, invoice.id);
    if (!Number.isSafeInteger(invoice.paid) || invoice.paid < 0 || invoice.paid > invoice.amount) {
      throw new Error(`Invalid allocated total on invoice ${invoice.id}.`);
    }
    invoiceById.set(invoice.id, invoice);
    append(invoiceIndex, normalizeReference(invoice.id), invoice);
    const remaining = invoice.amount - invoice.paid;
    outstanding.set(invoice.id, remaining);
    if (remaining > 0) {
      append(byCustomer, key(invoice.currency, invoice.customerId), invoice);
      append(byAmount, key(invoice.currency, remaining), invoice);
      append(byCustomerAmount, key(invoice.currency, invoice.customerId, remaining), invoice);
    }
  }
  for (const index of [byCustomer, byAmount, byCustomerAmount]) {
    for (const group of index.values()) group.sort(byInvoiceDate);
  }

  const fingerprints = new Map<string, string[]>();
  const seenPayments = new Set<string>();
  for (const payment of payments) {
    if (seenPayments.has(payment.id)) throw new Error(`Duplicate payment ID: ${payment.id}`);
    seenPayments.add(payment.id);
    validateAmount(payment.amount, payment.id);
    append(fingerprints, key(payment.customerId ?? "", payment.paymentDate, payment.amount,
      payment.currency, normalizeReference(payment.reference ?? "")), payment.id);
  }
  const suspectedDuplicates = new Set<string>();
  for (const ids of fingerprints.values()) {
    if (ids.length > 1) for (const id of ids) suspectedDuplicates.add(id);
  }

  function suggestions(payment: Payment, referenced: Invoice[]): Candidate[] {
    const pool = new Map<string, Invoice>();
    for (const invoice of referenced) pool.set(invoice.id, invoice);
    const matchingAmounts = payment.customerId
      ? byCustomerAmount.get(key(payment.currency, payment.customerId, payment.amount))
      : byAmount.get(key(payment.currency, payment.amount));
    for (const invoice of nearby(matchingAmounts, payment.paymentDate)) pool.set(invoice.id, invoice);
    if (payment.customerId) {
      for (const invoice of nearby(byCustomer.get(key(payment.currency, payment.customerId)), payment.paymentDate)) {
        pool.set(invoice.id, invoice);
      }
    }
    const candidates: Candidate[] = [];
    for (const invoice of pool.values()) {
      const remaining = outstanding.get(invoice.id)!;
      if (invoice.currency !== payment.currency || remaining < payment.amount ||
          (payment.customerId && invoice.customerId !== payment.customerId)) continue;
      let score = 0;
      const reasons: string[] = [];
      if (payment.customerId === invoice.customerId) {
        score += 50;
        reasons.push("Customer ID agrees");
      }
      if (remaining === payment.amount) {
        score += 30;
        reasons.push("Amount equals outstanding balance");
      } else {
        score += 10;
        reasons.push("Amount fits as a partial payment");
      }
      const days = Math.abs(Date.parse(payment.paymentDate) - Date.parse(invoice.invoiceDate)) / 86_400_000;
      if (days <= 7) score += 20;
      else if (days <= 30) score += 10;
      if (days <= 30) reasons.push(`Payment is within ${Math.ceil(days)} days of invoice date`);
      if (referenced.some((item) => item.id === invoice.id)) {
        score += 40;
        reasons.push("Reference names this invoice");
      }
      candidates.push({ invoiceId: invoice.id, score, reasons });
    }
    return candidates.sort((a, b) => b.score - a.score || compare(a.invoiceId, b.invoiceId)).slice(0, 5);
  }

  const allocations: AllocationProposal[] = [];
  const reviews: ReviewProposal[] = [];
  const ordered = [...payments].sort((a, b) => compare(a.paymentDate, b.paymentDate) || compare(a.id, b.id));
  for (const payment of ordered) {
    if (allocatedPaymentIds.has(payment.id)) continue;
    const normalized = normalizeReference(payment.reference ?? "");
    const referencedMap = new Map<string, Invoice>();
    for (const token of new Set([normalized, ...referenceTokens(normalized)])) {
      for (const invoice of invoiceIndex.get(token) ?? []) referencedMap.set(invoice.id, invoice);
    }
    const referenced = [...referencedMap.values()].sort((a, b) => compare(a.id, b.id));
    const review = (status: string, explanation: string) => {
      reviews.push({ paymentId: payment.id, status, explanation, candidates: suggestions(payment, referenced) });
    };
    if (["reversed", "deferred"].includes(payment.reviewStatus ?? "")) {
      review(payment.reviewStatus!, "A reviewer left this payment unresolved. An intentional manual allocation is required.");
      continue;
    }
    if (suspectedDuplicates.has(payment.id)) {
      review("suspected_duplicate", "Another payment has the same customer, date, amount, currency and normalized reference. Review both before allocating.");
      continue;
    }
    if (referenced.length > 1) {
      review("ambiguous_reference", `Reference resolves to more than one invoice: ${referenced.map((item) => item.id).join(", ")}.`);
      continue;
    }
    if (referenced.length === 0) {
      const candidates = suggestions(payment, []);
      reviews.push({
        paymentId: payment.id,
        status: normalized ? "unknown_reference" : candidates.length > 1 ? "ambiguous" : "needs_review",
        explanation: normalized
          ? "The reference does not resolve to a known whole invoice ID. Suggestions require review."
          : candidates.length > 1
            ? "No invoice reference was supplied and multiple compatible invoices are plausible. Select an invoice after review."
            : "No invoice reference was supplied. Amount and date similarities require human review.",
        candidates,
      });
      continue;
    }
    const invoice = referenced[0];
    if (invoice.currency !== payment.currency) {
      review("currency_mismatch", `Payment currency ${payment.currency} differs from invoice currency ${invoice.currency}.`);
      continue;
    }
    if (payment.customerId && payment.customerId !== invoice.customerId) {
      review("customer_mismatch", `Payment customer ${payment.customerId} differs from invoice customer ${invoice.customerId}.`);
      continue;
    }
    const remaining = outstanding.get(invoice.id)!;
    if (remaining === 0) {
      review("invoice_paid", `Referenced invoice ${invoice.id} is already fully paid.`);
      continue;
    }
    if (payment.amount > remaining) {
      review("overpayment", `Payment ${formatMoney(payment.amount)} exceeds ${invoice.id}'s outstanding balance of ${formatMoney(remaining)} ${invoice.currency}.`);
      continue;
    }
    const after = remaining - payment.amount;
    outstanding.set(invoice.id, after);
    allocations.push({
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: payment.amount,
      explanation: `Unique invoice reference ${invoice.id}; ${payment.customerId ? "customer and currency agree" : "currency agrees; no customer was supplied"}. Allocated ${formatMoney(payment.amount)} ${payment.currency}; ${after === 0 ? "invoice is fully paid" : `${formatMoney(after)} remains outstanding (partial payment)`}.`,
      evidence: {
        ruleVersion: RULE_VERSION,
        reference: payment.reference,
        normalizedReference: normalized,
        referencedInvoiceIds: [invoice.id],
        customerMatched: payment.customerId === invoice.customerId,
        currency: payment.currency,
        paymentAmount: payment.amount,
        outstandingBefore: remaining,
        outstandingAfter: after,
        paymentOrder: `${payment.paymentDate}/${payment.id}`,
      },
    });
  }
  // A suggestion collected early must not point at a balance consumed later in
  // this same run. Recompute against final proposed balances before returning.
  const paymentsById = new Map(payments.map((payment) => [payment.id, payment]));
  for (const review of reviews) {
    const payment = paymentsById.get(review.paymentId)!;
    const referenced = new Map<string, Invoice>();
    const normalized = normalizeReference(payment.reference ?? "");
    for (const token of new Set([normalized, ...referenceTokens(normalized)])) {
      for (const invoice of invoiceIndex.get(token) ?? []) referenced.set(invoice.id, invoice);
    }
    review.candidates = suggestions(payment, [...referenced.values()]);
    if (review.status === "ambiguous" || review.status === "needs_review") {
      review.status = review.candidates.length > 1 ? "ambiguous" : "needs_review";
      review.explanation = review.candidates.length > 1
        ? "No invoice reference was supplied and multiple compatible invoices are plausible. Select an invoice after review."
        : "No invoice reference was supplied. Amount and date similarities require human review.";
    }
  }
  return { allocations, reviews };
}
