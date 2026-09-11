import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorkspace, fixtureCsv, importRecords, processRun, getState } from '../src/server/service';
import { pool } from '../src/server/db';
import { RULE_VERSION } from '../src/domain/matching';
process.env.QUIET_PROGRESS='true';
const sizes=(process.argv.slice(2).length?process.argv.slice(2):['1000','10000','100000']).map(Number);
if(sizes.some(n=>!Number.isInteger(n)||n<12||n>100000)) throw new Error('Sizes must be integers from 12 to 100000.');
const setup={timestamp:new Date().toISOString(),node:process.version,os:`${os.type()} ${os.release()} ${os.arch()}`,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,hostMemoryGiB:Math.round(os.totalmem()/1024**3),database:(await pool.query('SELECT version()')).rows[0].version,ruleVersion:RULE_VERSION,seed:42,execution:'Local Node process; PostgreSQL 17 Docker container on same Windows host; same processRun handler used by the worker, excluding queue wait.',memoryMethod:'RSS sampled every 25ms in the benchmark Node process; includes fixtures, CSV strings, runtime and prior allocations. Excludes PostgreSQL and Docker. Sampling can miss short peaks; no forced GC. Not isolated incremental allocation memory.'};
const results:Record<string,unknown>[]=[];
async function measure<T>(fn:()=>Promise<T>) {
  const baselineRss=process.memoryUsage().rss;let peakRss=baselineRss;
  const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},25);
  const start=performance.now();
  try{const value=await fn();peakRss=Math.max(peakRss,process.memoryUsage().rss);return {value,durationMs:Math.round((performance.now()-start)*100)/100,baselineRssMiB:Math.round(baselineRss/1024**2),peakRssMiB:Math.round(peakRss/1024**2)};}finally{clearInterval(timer);}
}
await mkdir('artifacts',{recursive:true});
for(const size of sizes) {
  const ctx=await createWorkspace();const data=fixtureCsv(size);
  try {
    const imported=await measure(async()=>{
      await importRecords(ctx,{type:'invoice',filename:`synthetic-${size}-invoices.csv`,text:data.invoices});
      await importRecords(ctx,{type:'payment',filename:`synthetic-${size}-payments.csv`,text:data.payments});
    });
    const runId=randomUUID();await pool.query("INSERT INTO runs(id,workspace_id,principal_id,status,rule_version) VALUES($1,$2,$3,'queued',$4)",[runId,ctx.workspaceId,ctx.principalId,RULE_VERSION]);
    const matched=await measure(()=>processRun(runId));
    const allocations=(await pool.query("SELECT payment_id,invoice_id FROM allocations WHERE workspace_id=$1 AND source='automatic' AND reversed_at IS NULL",[ctx.workspaceId])).rows;
    const truth=new Map(data.fixture.truth.map(t=>[t.paymentId,t.invoiceId]));
    const correct=allocations.filter(a=>truth.get(a.payment_id)===a.invoice_id).length;
    const totals=(await getState(ctx)).totals;
    if(totals.invoiceTotal!==totals.allocatedTotal+totals.outstandingTotal||totals.paymentTotal!==totals.allocatedTotal+totals.unallocatedTotal) throw new Error('Accounting invariant failed.');
    const result={invoices:data.fixture.invoices.length,payments:data.fixture.payments.length,workspaceId:ctx.workspaceId,import:{durationMs:imported.durationMs,rowsPerSecond:Math.round(2*size/(imported.durationMs/1000)),baselineRssMiB:imported.baselineRssMiB,peakRssMiB:imported.peakRssMiB},reconciliation:{durationMs:matched.durationMs,paymentsPerSecond:Math.round(size/(matched.durationMs/1000)),baselineRssMiB:matched.baselineRssMiB,peakRssMiB:matched.peakRssMiB},automaticAllocations:allocations.length,correctAutomaticAllocations:correct,eligibleGroundTruthPairs:truth.size,precision:allocations.length?correct/allocations.length:null,eligibleRecall:truth.size?correct/truth.size:null,intentionallyRoutedToReview:data.fixture.reviewPaymentIds.length,actualUnallocatedPayments:totals.exceptionCount,accountingInvariants:'passed'};
    results.push(result);console.log(JSON.stringify(result));
  } catch(error) {const result={invoices:size,payments:size,error:error instanceof Error?error.message:String(error)};results.push(result);console.error(JSON.stringify(result));process.exitCode=1;}
  await writeFile('artifacts/benchmark-results.json',JSON.stringify({setup,recallDefinition:'Correct automatic allocations / independently authored unambiguous automation-eligible payment/invoice pairs. Deliberately ambiguous, duplicate, mismatch and overpayment cases are excluded. Precision is correct allocations / all automatic allocations.',observations:'One observation per size; no latency percentiles or improvement claims.',results},null,2)+'\n');
}
await pool.end();
