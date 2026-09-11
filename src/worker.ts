import { getBoss, QUEUE } from './server/queue';
import { processRun, markRunFailed } from './server/service';
import { pool } from './server/db';
import type { JobWithMetadata } from 'pg-boss';
const boss=await getBoss();
await boss.work<{runId:string;workspaceId:string}>(QUEUE,{includeMetadata:true,pollingIntervalSeconds:1},async jobs=>{
  for(const item of jobs) {
    const job=item as JobWithMetadata<{runId:string;workspaceId:string}>;
    console.log(JSON.stringify({event:'job_started',jobId:job.id,...job.data,attempt:job.retryCount+1}));
    try {await processRun(job.data.runId);}
    catch(error) {
      console.error(JSON.stringify({event:'job_failed',jobId:job.id,...job.data,attempt:job.retryCount+1,message:error instanceof Error?error.message:'Unknown worker error'}));
      if(job.retryCount>=job.retryLimit) await markRunFailed(job.data.runId,error instanceof Error?error.message:'Worker failed.');
      throw error;
    }
  }
});
// Expiry can exhaust retries without invoking a handler again. Reflect queue terminal state.
const reaper=setInterval(()=>void (async()=>{
  const expired=await pool.query("SELECT r.id,r.error FROM runs r JOIN pgboss.job j ON r.job_id=j.id WHERE j.name=$1 AND j.state='failed' AND r.status IN ('queued','running')",[QUEUE]);
  for(const row of expired.rows) await markRunFailed(row.id,row.error??'Worker expired after its retry limit. Start a new run to resume safely.');
})().catch(error=>console.error(JSON.stringify({event:'reaper_error',message:error.message}))),10000);
console.log(JSON.stringify({event:'worker_ready',queue:QUEUE}));
async function stop(){clearInterval(reaper);await boss.stop({graceful:true,timeout:30000});await pool.end();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
