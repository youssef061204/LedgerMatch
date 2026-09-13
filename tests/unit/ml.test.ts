import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { assertSplitIsolation, corruptReference, generateSample, SCENARIOS, WITHHELD_SCENARIOS } from '../../src/ml/dataset';
import { compactReference, editSimilarity, features, FEATURE_NAMES } from '../../src/ml/features';
import { parseModel, predict, rankCandidates, rankVectors, HOLD_STATUSES } from '../../src/ml/model';
import { reconcile } from '../../src/domain/matching';
import { loadRanker } from '../../src/server/ml';

describe('shared ML features', () => {
  test('normalizes fuzzy references without changing deterministic matching', () => {
    expect(compactReference(' inv-１２ /a ')).toBe('INV12A');
    expect(editSimilarity('INV123', 'INV123')).toBe(1);
    expect(editSimilarity('INV123', 'INV124')).toBeCloseTo(5/6);
    expect(editSimilarity('', '')).toBe(0);
  });
  test('features contain exact amount/customer evidence and no labels', () => {
    const sample=generateSample(0,0,42,false,'punctuation');
    const index=sample.y.indexOf(1); expect(index).toBeGreaterThanOrEqual(0);
    const vector=sample.x[index];
    expect(vector).toHaveLength(FEATURE_NAMES.length);
    expect(vector[10]).toBe(1); expect(vector[14]).toBe(1);expect(vector[2]).toBe(1);
    expect(features(sample.payment,sample.invoices,sample.candidates)).toEqual(sample.x);
    expect(features(sample.payment,[...sample.invoices].reverse(),sample.candidates)).toEqual(sample.x);
  });
  test('rejects missing candidate invoices and invalid numeric input', () => {
    const s=generateSample(1,0,42,false,'missing');
    expect(()=>features(s.payment,[],s.candidates)).toThrow();
    expect(()=>features({...s.payment,amount:NaN},s.invoices,s.candidates)).toThrow();
  });
});

describe('synthetic labels and isolation', () => {
  test.each([...SCENARIOS,...WITHHELD_SCENARIOS])('reproduces %s with independent valid labels', scenario => {
    const s=generateSample(12,1,123,WITHHELD_SCENARIOS.includes(scenario as 'ocr'),scenario);
    expect(generateSample(12,1,123,WITHHELD_SCENARIOS.includes(scenario as 'ocr'),scenario)).toEqual(s);
    expect(s.y).toEqual(s.candidates.map(c=>Number(c.invoiceId===s.trueInvoiceId)));
    expect(s.candidates.length).toBeLessThanOrEqual(20);
    for(const c of s.candidates) { const i=s.invoices.find(i=>i.id===c.invoiceId)!; expect(i.amount-i.paid).toBeGreaterThanOrEqual(s.payment.amount);expect(!s.payment.customerId||s.payment.customerId===i.customerId).toBe(true); }
    if(s.trueInvoiceId) {const i=s.invoices.find(i=>i.id===s.trueInvoiceId)!;expect(i.amount-i.paid).toBeGreaterThanOrEqual(s.payment.amount);expect(!s.payment.customerId||i.customerId===s.payment.customerId).toBe(true);}
    assertSplitIsolation([s]);
  });
  test('keeps latent truth outside retrieval and represents no-valid-invoice cases', () => {
    const missed=generateSample(0,0,42,false,'outside_candidates');
    expect(missed.validMatchExists).toBe(true);expect(missed.y.every(y=>y===0)).toBe(true);
    for(const scenario of ['overpayment','combined','incorrect_customer','no_match'] as const) expect(generateSample(0,0,42,false,scenario).trueInvoiceId).toBeNull();
  });
  test('detects entity/cohort leakage and withheld corruption contamination', () => {
    const a=generateSample(0,0),b=generateSample(9,0);
    assertSplitIsolation([a,b]);
    expect(()=>assertSplitIsolation([a,{...b,cohort:a.cohort}])).toThrow('leakage');
    expect(()=>assertSplitIsolation([a,{...b,invoices:[{...b.invoices[0],customerId:a.invoices[0].customerId},...b.invoices.slice(1)]}])).toThrow('leakage');
    expect(()=>assertSplitIsolation([{...a,scenario:'ocr'}])).toThrow('Withheld');
  });
  test('corruptions really alter the input reference', () => {
    for(const scenario of ['missing','truncated','typo','removed_prefix','removed_suffix','whitespace','punctuation','transposed','ocr'] as const) expect(corruptReference('INV-123450-AB',scenario)).not.toBe('INV-123450-AB');
  });
  test('expanded search preserves existing heuristic top-three and all allocations', () => {
    for(let n=0;n<100;n++) {
      const s=generateSample(n,0),original=reconcile(s.invoices,[s.payment]);
      const expanded=reconcile(s.invoices,[s.payment],new Set(),{candidateLimit:20});
      expect(expanded.allocations).toEqual(original.allocations);
      expect(expanded.reviews[0]?.candidates.slice(0,3)).toEqual(original.reviews[0]?.candidates.slice(0,3));
    }
  });
});

describe('versioned portable inference', () => {
  const bundle=()=>parseModel(JSON.parse(readFileSync('models/ranker.json','utf8')));
  test('matches native Python predictions for all three models', () => {
    const artifact=bundle();
    const probes=JSON.parse(readFileSync('models/parity.json','utf8')) as {model:'heuristic'|'logistic'|'xgboost';x:number[][];predictions:number[]}[];
    for(const probe of probes) for(let i=0;i<probe.x.length;i++) expect(predict(artifact.models[probe.model],probe.x[i])).toBeCloseTo(probe.predictions[i],5);
  });
  test('rejects incompatible schema, invalid trees and invalid vectors', () => {
    const artifact=bundle();
    expect(()=>parseModel({...artifact,featureVersion:'future'})).toThrow();
    expect(()=>parseModel({...artifact,featureNames:[]})).toThrow();
    const bad=structuredClone(artifact);if(bad.models.xgboost.predictor.kind==='boosted') bad.models.xgboost.predictor.trees[0].left[0]=0;
    expect(()=>parseModel(bad)).toThrow('cyclic');
    expect(()=>predict(artifact.models.xgboost,[NaN])).toThrow();
  });
  test('empty candidates abstain and threshold boundary is inclusive', () => {
    const artifact=bundle(),s=generateSample(0,0,42,false,'punctuation');
    expect(rankCandidates(artifact,s.payment,[],[],'needs_review').recommendation.state).toBe('abstained');
    const confidence=rankVectors(artifact.models.xgboost,s.x,s.candidates.map(c=>c.invoiceId)).confidence;
    artifact.models.xgboost.threshold=confidence;
    expect(rankCandidates(artifact,s.payment,s.invoices,s.candidates,s.status).recommendation.state).toBe('recommended');
    artifact.models.xgboost.threshold=confidence+0.00001;
    expect(rankCandidates(artifact,s.payment,s.invoices,s.candidates,s.status).recommendation.state).toBe('abstained');
  });
  test.each([...HOLD_STATUSES])('never recommends across the %s review hold', status => {
    const artifact=bundle(),s=generateSample(0,0,42,false,'missing');artifact.models.xgboost.threshold=0;
    expect(rankCandidates(artifact,s.payment,s.invoices,s.candidates,status).recommendation.state).toBe('abstained');
  });
  test('disabled mode does not require an artifact',async()=>{expect(await loadRanker(false)).toBeNull();});
  test('missing and invalid model filenames fall back without throwing',async()=>{
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      vi.stubEnv('ML_MODEL_FILE','missing-test-model.json');expect(await loadRanker(true)).toBeNull();
      vi.stubEnv('ML_MODEL_FILE','../outside.json');expect(await loadRanker(true)).toBeNull();
      expect(warning).toHaveBeenCalled();
    } finally {vi.unstubAllEnvs();warning.mockRestore();}
  });
});
