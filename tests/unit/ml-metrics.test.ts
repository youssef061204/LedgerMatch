import { expect,test } from 'vitest';
import { summarize,wilson,type Outcome } from '../../src/ml/metrics';
const make=(overrides:Partial<Outcome>):Outcome=>({id:'x',scenario:'missing',difficulty:'hard',valid:true,retrieved:true,rank:1,candidateCount:5,topInvoiceId:'I',truth:'I',confidence:0.9,accepted:true,correct:true,held:false,...overrides});
test('metrics include retrieval misses, false recommendations and negative groups in the correct denominators',()=>{
  const metrics=summarize([make({}),make({rank:3,correct:false,accepted:false}),make({rank:null,retrieved:false,correct:false,accepted:false}),make({valid:false,truth:null,rank:null,retrieved:false,correct:false})]);
  expect(metrics.top1Accuracy).toBeCloseTo(1/3);expect(metrics.top3Recall).toBeCloseTo(2/3);expect(metrics.mrr).toBeCloseTo((1+1/3)/3);
  expect(metrics.precision).toBe(0.5);expect(metrics.coverage).toBe(0.5);expect(metrics.falseRecommendations).toBe(1);expect(metrics.noMatchRecall).toBe(0);
  expect(metrics.proxy.meanInspectionSteps).toBeCloseTo(10/3);
});
test('empty denominators are null, and confidence intervals do not imply perfect certainty',()=>{
  expect(summarize([]).precision).toBeNull();expect(summarize([]).top1Accuracy).toBeNull();expect(wilson(0,0)).toBeNull();expect(wilson(100,100)![0]).toBeLessThan(1);
});
