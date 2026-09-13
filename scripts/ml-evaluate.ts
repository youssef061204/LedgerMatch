import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertSplitIsolation, type Sample } from '../src/ml/dataset';
import { parseModel, type ModelName, rankCandidates } from '../src/ml/model';
import { features } from '../src/ml/features';
import { outcome, summarize, type Outcome } from '../src/ml/metrics';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const dir='.local/ml-data';const manifest=JSON.parse(await readFile(`${dir}/manifest.json`,'utf8'));
const modelText=await readFile('models/ranker.json','utf8');const bundle=parseModel(JSON.parse(modelText));
const trained=bundle.metadata.dataset as typeof manifest;
if(JSON.stringify(trained)!==JSON.stringify(manifest)) throw new Error('Dataset differs from frozen training manifest.');
for(const [file,hash] of Object.entries(manifest.sourceHashes)) if(sha(await readFile(file))!==hash) throw new Error(`Source changed since dataset freeze: ${file}`);
const names:ModelName[]=['heuristic','logistic','xgboost'];
const partitions:Record<string,Sample[]>={};
for(const split of ['train','validation','test','robustness']) {
  const bytes=await readFile(`${dir}/${split}.jsonl`);
  if(sha(bytes)!==manifest.files[split])throw new Error(`Dataset integrity mismatch: ${split}`);
  partitions[split]=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
}
assertSplitIsolation(Object.values(partitions).flat());
const quantile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*values.length)-1)]??0;
function evaluate(samples:Sample[]) {
  const exceptions=samples.filter(s=>s.route==='exception');
  const rows=Object.fromEntries(names.map(name=>[name,exceptions.map(s=>outcome(s,bundle.models[name]))])) as Record<ModelName,Outcome[]>;
  const models=Object.fromEntries(names.map(name=>[name,summarize(rows[name])])) as Record<ModelName,ReturnType<typeof summarize>>;
  const breakdown=Object.fromEntries(['scenario','difficulty'].map(field=>[field,Object.fromEntries([...new Set(exceptions.map(s=>s[field as 'scenario'|'difficulty']))].sort().map(value=>[value,Object.fromEntries(names.map(name=>[name,summarize(rows[name].filter(r=>r[field as 'scenario'|'difficulty']===value))]))]))]));
  const precisionCoverage=Object.fromEntries(names.map(name=>[name,bundle.models[name].precisionTargets.map(t=>({targetValidationPrecision:t.target,threshold:t.threshold,validationAccepted:t.accepted,validationPrecision:t.precision,validationCoverage:t.coverage,...summarize(rows[name].map(r=>({...r,accepted:r.candidateCount>0&&!r.held&&r.confidence>=t.threshold})))}))]));
  const categories={difficult_success:(i:number)=>rows.xgboost[i].correct&&rows.xgboost[i].difficulty==='hard',model_win:(i:number)=>rows.xgboost[i].correct&&!rows.heuristic[i].correct,heuristic_win:(i:number)=>!rows.xgboost[i].correct&&rows.heuristic[i].correct,model_failure:(i:number)=>!rows.xgboost[i].correct&&rows.xgboost[i].valid,abstention:(i:number)=>!rows.xgboost[i].accepted};
  const examples=Object.fromEntries(Object.entries(categories).map(([category,filter])=>[category,exceptions.map((_,i)=>i).filter(filter).slice(0,3).map(i=>({payment:exceptions[i].payment,scenario:exceptions[i].scenario,truth:exceptions[i].trueInvoiceId,heuristic:rows.heuristic[i],model:rows.xgboost[i],candidates:rankCandidates(bundle,exceptions[i].payment,exceptions[i].invoices,exceptions[i].candidates,exceptions[i].status).candidates}))]));
  const a=models.heuristic.top1Accuracy??0,b=models.xgboost.top1Accuracy??0;
  return {deterministicControls:samples.length-exceptions.length,models,breakdown,precisionCoverage,examples,improvement:{top1PercentagePoints:(b-a)*100,relativeErrorReduction:a<1?(b-a)/(1-a):null,proxyInspectionReduction:1-(models.xgboost.proxy.meanInspectionSteps??0)/(models.heuristic.proxy.meanInspectionSteps??1)}};
}
// No fitting/tuning occurs below. Test features are checked against the shared runtime implementation.
const test=partitions.test.filter(s=>s.route==='exception');
for(const sample of test) if(JSON.stringify(features(sample.payment,sample.invoices,sample.candidates))!==JSON.stringify(sample.x)) throw new Error('Training/inference feature mismatch');
const inferenceMs:number[]=[];
for(const sample of test.slice(0,100))rankCandidates(bundle,sample.payment,sample.invoices,sample.candidates,sample.status);
for(const sample of test) {const start=performance.now();rankCandidates(bundle,sample.payment,sample.invoices,sample.candidates,sample.status);inferenceMs.push(performance.now()-start);}
const result={version:'1.0.0',evaluatedAt:new Date().toISOString(),modelId:bundle.modelId,modelSha256:sha(modelText),dataset:manifest,training:bundle.metadata,
  definitions:{ranking:'Top-1/top-3/MRR denominator: all valid-match exceptions, including retrieval misses. No-valid-invoice groups assessed separately and included in precision/coverage. Exact deterministic controls excluded.',heuristic:'Original scoring and retrieval; pool cap increased from 5 to 20 identically for all models. Top-1/top-3 unchanged; MRR and retrieval recall describe the shared 20-candidate pool, not the old five-result display.',confidence:'Group-level probability that the top candidate is correct; calibrated on synthetic validation only. Abstention is a review decision, not proof that no invoice exists.',precision:'Correct accepted recommendations / all accepted recommendations; coverage = accepted / all exceptions. Empirical validation targets are not guarantees on test or real records.',generalization:'Separate entities plus OCR/transposition corruptions withheld from train/validation and larger candidate ambiguity.',proxy:'Algorithmic candidate inspection proxy only. No human participants, review-time measurements or labor-savings claims.'},
  test:evaluate(partitions.test),robustness:evaluate(partitions.robustness),
  inference:{samples:inferenceMs.length,warmup:100,totalMs:inferenceMs.reduce((a,b)=>a+b,0),p50Ms:quantile(inferenceMs,0.5),p95Ms:quantile(inferenceMs,0.95),p99Ms:quantile(inferenceMs,0.99),definition:'Sequential per-exception shared feature computation + model traversal + calibration + explanation; excludes database, candidate retrieval, model loading and HTTP.'}};
await mkdir('artifacts/evaluation',{recursive:true});await writeFile('artifacts/evaluation/ml.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({test:result.test.models,robustness:result.robustness.models,inference:result.inference},null,2));
