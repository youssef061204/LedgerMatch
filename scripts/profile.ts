import { performance } from 'node:perf_hooks';
import { mkdir,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createWorkspace,seedWorkspace } from '../src/server/service';
import { pool } from '../src/server/db';
import { generateFixture } from '../src/domain/fixtures';
import { reconcile } from '../src/domain/matching';
const fixture=generateFixture(1000,42);const start=performance.now();const result=reconcile(fixture.invoices,fixture.payments);const pureMs=performance.now()-start;
const ctx=await createWorkspace();await seedWorkspace(ctx,false,1000);const client=await pool.connect();
try{
  await client.query('BEGIN');
  const rows=result.allocations.slice(0,100).map(a=>({...a,id:randomUUID()}));
  const plan=await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT TEXT) INSERT INTO allocations(id,workspace_id,payment_id,invoice_id,amount,source,explanation,evidence) SELECT x.id,$1,x."paymentId",x."invoiceId",x.amount,'automatic',x.explanation,x.evidence FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,"paymentId" text,"invoiceId" text,amount bigint,explanation text,evidence jsonb)`,[ctx.workspaceId,JSON.stringify(rows)]);
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/bottleneck-investigation.txt',`Measured ${new Date().toISOString()}\nPure matching 1000 invoices + 1000 payments: ${pureMs.toFixed(2)} ms (one observation).\nPostgreSQL 100-allocation batch below is rolled back and excludes audit/progress writes. Not a before/after comparison.\n${plan.rows.map(r=>r['QUERY PLAN']).join('\n')}\n`);
  console.log(`Pure matcher: ${pureMs.toFixed(2)} ms; allocation EXPLAIN saved to artifacts/bottleneck-investigation.txt.`);
}finally{await client.query('ROLLBACK');client.release();await pool.end();}
