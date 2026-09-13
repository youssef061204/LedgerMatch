import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorkspace, fixtureCsv, importRecords, processRun, getState, type RunTimings } from '../src/server/service';
import { pool } from '../src/server/db';
import { RULE_VERSION } from '../src/domain/matching';

process.env.QUIET_PROGRESS='true';
const size=Number(process.argv[2]??100000), trials=Number(process.argv[3]??3);
if(!Number.isInteger(size)||size<12||size>100000||!Number.isInteger(trials)||trials<1||trials>10) throw new Error('Use size 12..100000 and trials 1..10.');
const quantile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]??0;};
const modes=[{name:'baseline',batchSize:100,mlEnabled:false},{name:'optimized',batchSize:1000,mlEnabled:false},{name:'integrated',batchSize:1000,mlEnabled:true}];
type Observation={mode:string;trial:number;workspaceId:string;importMs:number;elapsedMs:number;paymentsPerSecond:number;peakRssMiB:number;timings:RunTimings;correct:number;precision:number;eligibleRecall:number;reviews:number};
const observations:Observation[]=[];
const setup={timestamp:new Date().toISOString(),node:process.version,os:`${os.type()} ${os.release()} ${os.arch()}`,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,hostMemoryGiB:os.totalmem()/1024**3,database:(await pool.query('SELECT version()')).rows[0].version,seed:42,size,trials,serviceSha256:createHash('sha256').update(await readFile('src/server/service.ts')).digest('hex'),execution:'Local Node process and PostgreSQL Docker on same host. Identical freshly imported seed-42 workloads; queue wait excluded. Modes rotated across trials; no forced cold caches or GC. Existing evidence retained.',latencyDefinition:'p50/p95/p99 are wall-clock persistence transaction batch latencies (100 vs 1000 effects), NOT individual payment/request latency. Total run median/min/max are separate.',memoryDefinition:'RSS sampled every 25ms; Node process only including fixtures and retained allocations; excludes PostgreSQL/Docker; may miss brief peaks.'};
await mkdir('artifacts/performance',{recursive:true});
try {
  for(let trial=0;trial<trials;trial++) for(let offset=0;offset<modes.length;offset++) {
    const mode=modes[(offset+trial)%modes.length];
    const ctx=await createWorkspace();const data=fixtureCsv(size);
    const importStart=performance.now();
    await importRecords(ctx,{type:'invoice',filename:'performance-invoices.csv',text:data.invoices});
    await importRecords(ctx,{type:'payment',filename:'performance-payments.csv',text:data.payments});
    const importMs=performance.now()-importStart;
    const id=randomUUID();await pool.query("INSERT INTO runs(id,workspace_id,principal_id,status,rule_version) VALUES($1,$2,$3,'queued',$4)",[id,ctx.workspaceId,ctx.principalId,RULE_VERSION]);
    let peak=process.memoryUsage().rss; const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},25);
    const start=performance.now();let timings:RunTimings|undefined;
    try { await processRun(id,{...mode,onTimings:value=>{timings=value;}}); } finally { clearInterval(timer); }
    const elapsedMs=performance.now()-start;
    if(!timings) throw new Error('Missing run timings');
    if(mode.mlEnabled&&!timings.modelId) throw new Error('Integrated benchmark requires a valid trained model');
    const actual=(await pool.query("SELECT payment_id,invoice_id FROM allocations WHERE workspace_id=$1 AND source='automatic' AND reversed_at IS NULL",[ctx.workspaceId])).rows;
    const truth=new Map(data.fixture.truth.map(t=>[t.paymentId,t.invoiceId]));
    const correct=actual.filter(a=>truth.get(a.payment_id)===a.invoice_id).length;
    const {totals}=await getState(ctx);
    if(correct!==truth.size||correct!==actual.length||totals.invoiceTotal!==totals.allocatedTotal+totals.outstandingTotal||totals.paymentTotal!==totals.allocatedTotal+totals.unallocatedTotal||totals.exceptionCount!==data.fixture.reviewPaymentIds.length) throw new Error('Benchmark correctness failed');
    const row={mode:mode.name,trial:trial+1,workspaceId:ctx.workspaceId,importMs,elapsedMs,paymentsPerSecond:size/(elapsedMs/1000),peakRssMiB:peak/1024**2,timings,correct,precision:correct/actual.length,eligibleRecall:correct/truth.size,reviews:totals.exceptionCount};
    observations.push(row);
    console.log(JSON.stringify({...row,timings:{...timings,batchMs:undefined,batchCount:timings.batchMs.length}}));
    await writeFile('artifacts/performance/progress.json',JSON.stringify({setup,observations},null,2)+'\n');
  }
  const summary=Object.fromEntries(modes.map(mode=>{
    const rows=observations.filter(r=>r.mode===mode.name),times=rows.map(r=>r.elapsedMs),batches=rows.flatMap(r=>r.timings.batchMs);
    const medianMs=quantile(times,0.5);
    return [mode.name,{trials:rows.length,batchSize:mode.batchSize,medianMs,minMs:Math.min(...times),maxMs:Math.max(...times),paymentsPerSecond:size/(medianMs/1000),batchP50Ms:quantile(batches,0.5),batchP95Ms:quantile(batches,0.95),batchP99Ms:quantile(batches,0.99),medianComputeMs:quantile(rows.map(r=>r.timings.computeMs),0.5),medianMlMs:quantile(rows.map(r=>r.timings.mlMs),0.5),medianPersistenceMs:quantile(rows.map(r=>r.timings.persistenceMs),0.5),maxRssMiB:Math.max(...rows.map(r=>r.peakRssMiB)),correctAllocations:rows[0].correct}];
  }));
  await writeFile('artifacts/performance/latest.json',JSON.stringify({version:'1.0.0',setup,summary,observations},null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally { await pool.end(); }
