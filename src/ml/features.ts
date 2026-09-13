import { normalizeReference, referenceTokens, type Candidate, type Invoice, type Payment } from '../domain/matching';

export const FEATURE_VERSION = '1.0.0';
export const FEATURE_NAMES = [
  'reference_exact', 'reference_normalized', 'reference_edit_similarity', 'reference_contains',
  'reference_prefix', 'reference_suffix', 'numeric_similarity', 'reference_missing',
  'amount_log_difference', 'amount_relative_difference', 'amount_exact', 'amount_within_5_cents',
  'amount_within_1_percent', 'payment_fraction', 'customer_agrees', 'customer_missing',
  'customer_similarity', 'invoice_age_days', 'absolute_invoice_age_days', 'days_from_due',
  'absolute_days_from_due', 'candidate_count', 'amount_rank', 'recency_rank',
  'heuristic_score', 'heuristic_margin', 'same_amount_count',
] as const;
export const compactReference = (s: string) => normalizeReference(s).replace(/[^A-Z0-9]/g, '');

export function editSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
const bound = (n: number) => Math.max(-730, Math.min(730, n));

/** This is the sole feature implementation, used by dataset export and live inference. Labels never enter it. */
export function features(payment: Payment, invoices: Invoice[], candidates: Candidate[]): number[][] {
  const byId = new Map(invoices.map(i => [i.id, i]));
  const reference = compactReference((payment.reference ?? '').slice(0, 1000));
  const numeric = reference.replace(/\D/g, '');
  const amounts = candidates.map(c => { const i = byId.get(c.invoiceId); if (!i) throw new Error('Candidate invoice missing'); return i.amount - i.paid; });
  const ages = candidates.map(c => Math.abs(days(payment.paymentDate, byId.get(c.invoiceId)!.invoiceDate)));
  const scores = candidates.map(c => c.score).sort((a, b) => b - a);
  return candidates.map((candidate, index) => {
    const invoice = byId.get(candidate.invoiceId)!;
    const id = compactReference(invoice.id);
    const difference = Math.abs(payment.amount - amounts[index]);
    const age = days(payment.paymentDate, invoice.invoiceDate);
    const due = days(payment.paymentDate, invoice.dueDate);
    // Compare complete remittance and individual words to avoid length bias from prose.
    const tokens = [reference, ...referenceTokens(payment.reference ?? '').slice(0, 32).map(compactReference)];
    const similarity = Math.max(...tokens.map(t => editSimilarity(t, id)));
    const row = [
      Number(payment.reference === invoice.id), Number(normalizeReference(payment.reference ?? '') === normalizeReference(invoice.id)),
      similarity, Number(!!reference && reference.includes(id)),
      Number(!!reference && (reference.startsWith(id) || id.startsWith(reference))),
      Number(!!reference && (reference.endsWith(id) || id.endsWith(reference))),
      editSimilarity(numeric, id.replace(/\D/g, '')), Number(!reference),
      Math.log1p(difference), difference / Math.max(1, amounts[index]), Number(difference === 0), Number(difference <= 5),
      Number(difference / Math.max(1, amounts[index]) <= 0.01), payment.amount / Math.max(1, amounts[index]),
      Number(payment.customerId === invoice.customerId), Number(!payment.customerId),
      editSimilarity(compactReference(payment.customerId ?? ''), compactReference(invoice.customerId)),
      bound(age), bound(Math.abs(age)), bound(due), bound(Math.abs(due)), candidates.length,
      amounts.filter(a => Math.abs(payment.amount - a) < difference).length / Math.max(1, candidates.length),
      ages.filter(a => a < ages[index]).length / Math.max(1, candidates.length),
      candidate.score / 140, ((scores[0] ?? 0) - (scores[1] ?? 0)) / 140,
      amounts.filter(a => a === amounts[index]).length,
    ].map(Math.fround);
    if (row.length !== FEATURE_NAMES.length || row.some(n => !Number.isFinite(n))) throw new Error('Invalid feature vector');
    return row;
  });
}
