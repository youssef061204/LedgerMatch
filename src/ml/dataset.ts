import { reconcile, type Invoice, type Payment, type Candidate } from '../domain/matching';
import { features } from './features';

export const GENERATOR_VERSION = '1.0.0';
export const SCENARIOS = ['clean', 'missing', 'truncated', 'typo', 'removed_prefix', 'removed_suffix', 'whitespace', 'punctuation', 'incorrect_reference', 'rounding', 'underpayment', 'overpayment', 'partial', 'combined', 'duplicate_amount', 'near_amount', 'missing_customer', 'incorrect_customer', 'similar_customer', 'before_due', 'after_due', 'stale', 'no_match', 'outside_candidates', 'duplicate_looking', 'misleading'] as const;
export const WITHHELD_SCENARIOS = ['transposed', 'ocr'] as const;
export type Scenario = typeof SCENARIOS[number] | typeof WITHHELD_SCENARIOS[number];
export type Split = 'train' | 'validation' | 'test' | 'robustness';
export interface Sample {
  id: string; cohort: string; split: Split; validationRole: 'selection' | 'calibration' | 'threshold';
  scenario: Scenario; difficulty: 'easy' | 'medium' | 'hard'; trueInvoiceId: string | null; validMatchExists: boolean;
  route: 'deterministic' | 'exception'; status: string; payment: Payment; invoices: Invoice[];
  candidates: Candidate[]; x: number[][]; y: number[];
}
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const iso = (day: number) => new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);

export function corruptReference(id: string, scenario: Scenario): string | null {
  switch (scenario) {
    case 'clean': return id;
    case 'missing': return null;
    case 'truncated': return id.slice(0, -4);
    case 'typo': return id.slice(0, 7) + 'X' + id.slice(8);
    case 'removed_prefix': return id.slice(4);
    case 'removed_suffix': return id.slice(0, -2);
    case 'whitespace': return id.split('').join(' ');
    case 'punctuation': return id.replaceAll('-', '/');
    case 'incorrect_reference': return 'TRANSFER-NOT-RECORDED';
    case 'transposed': return id.slice(0, 6) + id[7] + id[6] + id.slice(8) + '?';
    case 'ocr': return id.replaceAll('0', 'O').replaceAll('1', 'I').replaceAll('5', 'S') + '?';
    default: return `Remittance ${id.replaceAll('-', '')}`;
  }
}

/** Latent target is drawn before corrupting inputs; neither matcher nor feature scores create labels. */
export function generateSample(cohortIndex: number, within: number, seed = 20260913, robustness = false, forcedScenario?: Scenario): Sample {
  const random = seededRandom((seed ^ Math.imul(cohortIndex + 1, 104729) ^ Math.imul(within + 1, 7919)) >>> 0);
  const integer = (n: number) => Math.floor(random() * n);
  const cohort = `${robustness ? 'robust' : 'main'}-${cohortIndex}`;
  const id = `${cohort}-${within}`;
  const scenario = forcedScenario ?? (robustness ? WITHHELD_SCENARIOS[integer(WITHHELD_SCENARIOS.length)] : SCENARIOS[integer(SCENARIOS.length)]);
  const split: Split = robustness ? 'robustness' : cohortIndex % 10 < 6 ? 'train' : cohortIndex % 10 < 8 ? 'validation' : 'test';
  const customer = `ACCOUNT-${cohort}-MAPLE`;
  const count = scenario === 'outside_candidates' ? 80 : 6 + integer(robustness ? 24 : 13);
  const targetIndex = integer(count);
  const amount = 10000 + integer(900000);
  const paymentDay = 100 + integer(500);
  const serials = new Set<number>();
  const invoices: Invoice[] = Array.from({ length: count }, (_, index) => {
    let serial: number; do { serial = 100000 + integer(900000); } while (serials.has(serial)); serials.add(serial);
    const invoiceDay = paymentDay - integer(100);
    return { id: `INV-${serial}-${id}-${String.fromCharCode(65 + integer(26))}`, customerId: index % 5 === 0 ? `${customer}-NORTH` : customer,
      invoiceDate: iso(invoiceDay), dueDate: iso(invoiceDay + 14 + integer(46)), currency: 'CAD', paid: 0,
      amount: random() < 0.4 ? amount : amount + integer(100000) - 10000 };
  });
  const target = invoices[targetIndex];
  target.amount = amount; target.customerId = customer;
  target.invoiceDate = iso(paymentDay - 10 - integer(50)); target.dueDate = iso(paymentDay - 8 + integer(17));
  const payment: Payment = { id: `PAY-${id}`, customerId: customer, amount, currency: 'CAD', paymentDate: iso(paymentDay), reference: corruptReference(target.id, scenario) };
  let trueInvoiceId: string | null = target.id;
  if (scenario === 'rounding') payment.amount -= 1 + integer(5);
  if (scenario === 'underpayment') payment.amount -= 100 + integer(500);
  if (scenario === 'partial') payment.amount = Math.floor(amount * (0.2 + random() * 0.6));
  if (scenario === 'overpayment' || scenario === 'combined') { payment.amount = amount + (scenario === 'combined' ? invoices[(targetIndex + 1) % count].amount : 100); trueInvoiceId = null; }
  if (scenario === 'duplicate_amount' || scenario === 'missing' || scenario === 'incorrect_reference') for (const i of invoices) i.amount = amount;
  if (scenario === 'near_amount') for (const i of invoices) if (i !== target) i.amount = amount + 1 + integer(10);
  if (scenario === 'missing_customer') payment.customerId = null;
  if (scenario === 'incorrect_customer') { payment.customerId = `ACCOUNT-${cohort}-UNKNOWN`; trueInvoiceId = null; }
  if (scenario === 'similar_customer') { target.customerId = `${customer}-NORTH`; payment.customerId = target.customerId; }
  if (scenario === 'before_due') target.dueDate = iso(paymentDay + 20 + integer(30));
  if (scenario === 'after_due') target.dueDate = iso(paymentDay - 7 - integer(20));
  if (scenario === 'stale') { target.invoiceDate = iso(paymentDay - 365); target.dueDate = iso(paymentDay - 335); }
  if (scenario === 'no_match') { trueInvoiceId = null; payment.reference = `INV-${100000 + integer(900000)}-EXTERNAL`; payment.amount += 53; }
  if (scenario === 'outside_candidates') {
    payment.reference = null; payment.customerId = null;
    for (const i of invoices) { i.amount = amount; i.invoiceDate = iso(paymentDay - 1); i.dueDate = iso(paymentDay + 29); }
    target.invoiceDate = iso(paymentDay - 700); target.dueDate = iso(paymentDay - 670);
  }
  if (scenario === 'duplicate_looking') {
    const other = invoices[(targetIndex + 1) % count];
    Object.assign(other, { ...target, id: other.id }); payment.reference = null;
  }
  if (scenario === 'misleading') {
    const other = invoices[(targetIndex + 1) % count]; other.customerId = customer;
    payment.reference = `Payment ${other.id.replaceAll('-', '')}`;
  }
  for (const invoice of invoices) if (invoice.dueDate < invoice.invoiceDate) invoice.dueDate = invoice.invoiceDate;
  const result = reconcile(invoices, [payment], new Set(), { candidateLimit: 20 });
  const candidates = result.reviews[0]?.candidates ?? [];
  return { id, cohort, split, validationRole: (['selection', 'calibration', 'threshold'] as const)[Math.floor(cohortIndex / 10) % 3], scenario,
    difficulty: ['clean', 'whitespace', 'punctuation'].includes(scenario) ? 'easy' : ['missing', 'misleading', 'outside_candidates', 'duplicate_looking', 'no_match', 'incorrect_reference'].includes(scenario) || robustness ? 'hard' : 'medium',
    trueInvoiceId, validMatchExists: trueInvoiceId !== null, route: result.allocations.length ? 'deterministic' : 'exception',
    status: result.reviews[0]?.status ?? 'allocated', payment, invoices, candidates,
    x: features(payment, invoices, candidates), y: candidates.map(c => Number(c.invoiceId === trueInvoiceId)) };
}

export function assertSplitIsolation(samples: Iterable<Sample>): void {
  const owners = new Map<string, string>();
  for (const sample of samples) {
    const partition = sample.split === 'validation' ? `${sample.split}/${sample.validationRole}` : sample.split;
    for (const key of [sample.cohort, sample.id, sample.payment.id, ...sample.invoices.flatMap(i => [i.id, i.customerId])]) {
      const prior = owners.get(key);
      if (prior && prior !== partition) throw new Error(`Split leakage: ${key} occurs in ${prior} and ${partition}`);
      owners.set(key, partition);
    }
    if (sample.y.some((y, i) => y !== Number(sample.candidates[i].invoiceId === sample.trueInvoiceId))) throw new Error('Invalid target label');
    if (sample.trueInvoiceId !== null && !sample.invoices.some(i => i.id === sample.trueInvoiceId)) throw new Error('Missing latent target');
    if (sample.split !== 'robustness' && WITHHELD_SCENARIOS.includes(sample.scenario as typeof WITHHELD_SCENARIOS[number])) throw new Error('Withheld corruption leaked');
  }
}
