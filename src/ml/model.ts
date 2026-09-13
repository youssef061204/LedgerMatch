import { z } from 'zod';
import { FEATURE_NAMES, FEATURE_VERSION, features } from './features';
import type { Candidate, Invoice, Payment } from '../domain/matching';

const linearSchema = z.object({ coefficients: z.array(z.number().finite()), intercept: z.number().finite() });
const treeSchema = z.object({ feature: z.array(z.number().int()), threshold: z.array(z.number().finite()), left: z.array(z.number().int()), right: z.array(z.number().int()), value: z.array(z.number().finite()) });
const predictorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heuristic') }),
  z.object({ kind: z.literal('linear'), coefficients: z.array(z.number().finite()), intercept: z.number().finite() }),
  z.object({ kind: z.literal('boosted'), baseMargin: z.number().finite(), trees: z.array(treeSchema).min(1).max(1000) }),
]);
const modelSchema = z.object({ predictor: predictorSchema, calibration: linearSchema, threshold: z.number().finite().min(0).max(1.01), precisionTargets: z.array(z.object({ target: z.number(), threshold: z.number(), accepted: z.number(), precision: z.number().nullable(), coverage: z.number() })) });
const bundleSchema = z.object({ version: z.literal('1.0.0'), featureVersion: z.literal(FEATURE_VERSION), featureNames: z.array(z.string()), modelId: z.string().min(1), selected: z.literal('xgboost'), models: z.object({ heuristic: modelSchema, logistic: modelSchema, xgboost: modelSchema }), metadata: z.record(z.string(), z.unknown()) });
export type ModelBundle = z.infer<typeof bundleSchema>;
export type Model = ModelBundle['models']['xgboost'];
export type ModelName = keyof ModelBundle['models'];
export interface Recommendation { state: 'recommended' | 'abstained'; invoiceId: string | null; confidence: number; threshold: number; modelId: string; reason: string; }

export function parseModel(value: unknown): ModelBundle {
  const bundle = bundleSchema.parse(value);
  if (JSON.stringify(bundle.featureNames) !== JSON.stringify(FEATURE_NAMES)) throw new Error('Incompatible feature schema');
  for (const model of Object.values(bundle.models)) {
    if (model.calibration.coefficients.length !== 3) throw new Error('Invalid calibration schema');
    if (model.predictor.kind === 'linear' && model.predictor.coefficients.length !== FEATURE_NAMES.length) throw new Error('Invalid linear schema');
    if (model.predictor.kind === 'boosted') for (const tree of model.predictor.trees) {
      const n = tree.feature.length;
      if (!n || n > 10000 || [tree.left, tree.right, tree.threshold, tree.value].some(a => a.length !== n)) throw new Error('Invalid tree shape');
      for (let i = 0; i < n; i++) {
        if (tree.feature[i] < -1 || tree.feature[i] >= FEATURE_NAMES.length) throw new Error('Invalid tree feature');
        if (tree.feature[i] !== -1 && [tree.left[i], tree.right[i]].some(c => c <= i || c >= n)) throw new Error('Invalid or cyclic tree');
      }
    }
  }
  return bundle;
}
export const sigmoid = (n: number) => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, n))));
export function predict(model: Model, row: number[]): number {
  if (row.length !== FEATURE_NAMES.length || row.some(n => !Number.isFinite(n))) throw new Error('Invalid inference features');
  const predictor = model.predictor;
  if (predictor.kind === 'heuristic') return row[24];
  if (predictor.kind === 'linear') return predictor.intercept + row.reduce((sum, x, i) => sum + x * predictor.coefficients[i], 0);
  let margin = Math.fround(predictor.baseMargin);
  for (const tree of predictor.trees) {
    let node = 0;
    while (tree.feature[node] !== -1) node = Math.fround(row[tree.feature[node]]) < Math.fround(tree.threshold[node]) ? tree.left[node] : tree.right[node];
    margin = Math.fround(margin + Math.fround(tree.value[node]));
  }
  return margin;
}
export function rankVectors(model: Model, rows: number[][], ids: string[]) {
  if (rows.length !== ids.length) throw new Error('Candidate/feature length mismatch');
  const scores = rows.map(row => predict(model, row));
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
  if (!order.length) return { order, scores, confidence: 0 };
  const top = scores[order[0]], second = order.length > 1 ? scores[order[1]] : top;
  const calibration = [top, top - second, Math.log1p(order.length)];
  const confidence = sigmoid(model.calibration.intercept + calibration.reduce((sum, x, i) => sum + x * model.calibration.coefficients[i], 0));
  return { order, scores, confidence };
}
export const HOLD_STATUSES = new Set(['suspected_duplicate', 'ambiguous_reference', 'customer_mismatch', 'currency_mismatch', 'overpayment', 'invoice_paid', 'reversed', 'deferred']);
export function rankCandidates(bundle: ModelBundle, payment: Payment, invoices: Invoice[], candidates: Candidate[], status: string) {
  const model = bundle.models[bundle.selected];
  const rows = features(payment, invoices, candidates);
  const { order, scores, confidence } = rankVectors(model, rows, candidates.map(c => c.invoiceId));
  const held = HOLD_STATUSES.has(status);
  const accepted = order.length > 0 && !held && confidence >= model.threshold;
  const ranked = order.map(index => {
    const row = rows[index];
    const invoice = invoices.find(i => i.id === candidates[index].invoiceId)!;
    return { ...candidates[index], mlScore: scores[index], reasons: [
      `Reference similarity ${Math.round(row[2] * 100)}%`,
      `Amount difference ${Math.abs(payment.amount - (invoice.amount - invoice.paid))} cents`,
      payment.customerId ? 'Customer ID agrees' : 'Customer ID not supplied',
      `${Math.round(row[19])} days from due date`,
    ] };
  });
  const recommendation: Recommendation = { state: accepted ? 'recommended' : 'abstained', invoiceId: accepted ? ranked[0].invoiceId : null,
    confidence, threshold: model.threshold, modelId: bundle.modelId,
    reason: held ? 'A deterministic review hold requires independent evidence.' : !order.length ? 'No compatible candidate was retrieved.' : accepted ? 'Above the validated recommendation threshold. Reviewer confirmation required.' : 'Confidence is below the review threshold; a valid invoice may be missing.' };
  return { candidates: ranked.slice(0, 5), recommendation };
}
