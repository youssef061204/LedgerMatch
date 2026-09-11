import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, pool, transaction, type Client } from './db';
import { memberships } from './schema';
import { parseCsv, csvStringify, type ImportType } from '../domain/csv';
import { formatMoney } from '../domain/money';
import { generateFixture } from '../domain/fixtures';
import { reconcile, RULE_VERSION, type Invoice, type Payment } from '../domain/matching';
import { getBoss, QUEUE } from './queue';

export type Context={workspaceId:string;principalId:string};
export class AppError extends Error { constructor(message:string,public status=400,public errors?:unknown){super(message);} }
export async function requireMember(ctx:Context,write=false) {
  const [member]=await db.select().from(memberships).where(and(eq(memberships.workspaceId,ctx.workspaceId),eq(memberships.principalId,ctx.principalId)));
  if(!member) throw new AppError('Workspace access denied.',403);
  if(write && member.role!=='reviewer') throw new AppError('Viewers cannot change workspace records.',403);
  return member;
}
export async function audit(client:Client,ctx:Context,action:string,entityId:string,explanation:string,changes:unknown={}) {
  await client.query('INSERT INTO audit_events(id,workspace_id,actor,action,entity_id,explanation,changes) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.workspaceId,ctx.principalId,action,entityId,explanation,JSON.stringify(changes)]);
}
async function lockWorkspace(client:Client,ctx:Context,idle=false) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);
  const membership=await client.query("SELECT role FROM memberships WHERE workspace_id=$1 AND principal_id=$2",[ctx.workspaceId,ctx.principalId]);
  if(membership.rows[0]?.role!=='reviewer') throw new AppError('Reviewer access is required.',403);
  if(idle && (await client.query("SELECT id FROM runs WHERE workspace_id=$1 AND status IN ('queued','running')",[ctx.workspaceId])).rowCount) throw new AppError('Wait for the current reconciliation to finish before changing records.',409);
}
export async function createWorkspace() {
  const ctx={workspaceId:randomUUID(),principalId:randomUUID(),sessionId:randomUUID()};
  await transaction(async c=>{
    await c.query("INSERT INTO workspaces(id,name) VALUES($1,'Maple & Co. demo')",[ctx.workspaceId]);
    await c.query("INSERT INTO principals(id,name) VALUES($1,'Demo reviewer')",[ctx.principalId]);
    await c.query("INSERT INTO memberships VALUES($1,$2,'reviewer')",[ctx.workspaceId,ctx.principalId]);
    await c.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '7 days')",[ctx.sessionId,ctx.workspaceId,ctx.principalId]);
    await audit(c,ctx,'workspace_created',ctx.workspaceId,'Created an isolated synthetic demo workspace.');
  }); return ctx;
}
export type ImportInput={type:ImportType;filename:string;text:string;mapping?:Record<string,string>};
export async function importRecords(ctx:Context,input:ImportInput) {
  await requireMember(ctx,true);
  const parsed=parseCsv(input.text,input.type,input.mapping);
  if(parsed.errors.length) throw new AppError('The file has validation errors. No records were imported.',422,parsed.errors);
  const hash=createHash('sha256').update(input.text).digest('hex');
  return transaction(async c=>{
    await lockWorkspace(c,ctx,true);
    const existing=await c.query('SELECT id,row_count AS "rowCount",skipped FROM imports WHERE workspace_id=$1 AND type=$2 AND hash=$3',[ctx.workspaceId,input.type,hash]);
    if(existing.rowCount) return {...existing.rows[0],duplicate:true};
    const table=input.type==='invoice'?'invoices':'payments';
    const old=await c.query(`SELECT id,customer_id AS "customerId",amount,currency,${input.type==='invoice'?'invoice_date AS "invoiceDate",due_date AS "dueDate"':'payment_date AS "paymentDate",reference'} FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId]);
    const byId=new Map(old.rows.map(r=>[r.id,r]));
    const fresh:typeof parsed.records=[]; const conflicts:{row:number;field:string;message:string}[]=[];
    parsed.records.forEach((r,index)=>{
      const prior=byId.get(r.id);
      if(!prior) fresh.push(r);
      else if(Object.keys(prior).some(k=>prior[k]!==r[k as keyof typeof r])) conflicts.push({row:parsed.rowNumbers[index],field:'id',message:`${r.id} already exists with different fields. Existing records were not changed.`});
    });
    if(conflicts.length) throw new AppError('Conflicting identifiers. No records were imported.',409,conflicts.slice(0,200));
    if(old.rows.length+fresh.length>100000) throw new AppError('This workspace permits at most 100,000 invoices and 100,000 payments.',422);
    const id=randomUUID(),skipped=parsed.records.length-fresh.length;
    await c.query('INSERT INTO imports(id,workspace_id,type,filename,hash,row_count,skipped) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.workspaceId,input.type,input.filename,hash,fresh.length,skipped]);
    for(let offset=0;offset<parsed.records.length;offset+=1000) {
      const rows=parsed.records.slice(offset,offset+1000).map((r,i)=>({row_number:parsed.rowNumbers[offset+i],record_id:r.id,data:r}));
      await c.query('INSERT INTO import_rows SELECT $1,x.row_number,x.record_id,x.data FROM jsonb_to_recordset($2::jsonb) AS x(row_number int,record_id text,data jsonb)',[id,JSON.stringify(rows)]);
    }
    for(let offset=0;offset<fresh.length;offset+=1000) {
      const rows=JSON.stringify(fresh.slice(offset,offset+1000));
      if(input.type==='invoice') await c.query('INSERT INTO invoices SELECT $1,x.id,x."customerId",x."invoiceDate",x."dueDate",x.amount,x.currency,$2 FROM jsonb_to_recordset($3::jsonb) AS x(id text,"customerId" text,"invoiceDate" date,"dueDate" date,amount bigint,currency text)',[ctx.workspaceId,id,rows]);
      else await c.query('INSERT INTO payments(workspace_id,id,customer_id,payment_date,amount,currency,reference,import_id) SELECT $1,x.id,x."customerId",x."paymentDate",x.amount,x.currency,x.reference,$2 FROM jsonb_to_recordset($3::jsonb) AS x(id text,"customerId" text,"paymentDate" date,amount bigint,currency text,reference text)',[ctx.workspaceId,id,rows]);
    }
    await audit(c,ctx,'import_completed',id,`Imported ${fresh.length} ${input.type} records; ${skipped} identical records skipped.`,{filename:input.filename,hash,recordCount:fresh.length,skipped});
    return {id,rowCount:fresh.length,skipped,duplicate:false};
  });
}
export function fixtureCsv(size=240) {
  const fixture=generateFixture(size,42);
  return {fixture,invoices:csvStringify(fixture.invoices.map(i=>({invoice_id:i.id,customer_id:i.customerId,invoice_date:i.invoiceDate,due_date:i.dueDate,amount:formatMoney(i.amount),currency:i.currency}))),payments:csvStringify(fixture.payments.map(p=>({payment_id:p.id,customer_id:p.customerId??'',payment_date:p.paymentDate,amount:formatMoney(p.amount),currency:p.currency,reference:p.reference??''})))};
}
export async function seedWorkspace(ctx:Context,reset=false,size=240) {
  await requireMember(ctx,true);
  if(reset) throw new AppError('Reset creates a fresh isolated workspace through the demo endpoint; historical evidence is retained.',409);
  const data=fixtureCsv(size);
  const invoices=await importRecords(ctx,{type:'invoice',filename:'synthetic-invoices.csv',text:data.invoices});
  const payments=await importRecords(ctx,{type:'payment',filename:'synthetic-payments.csv',text:data.payments});
  return {invoices,payments};
}
const invoiceSelect='SELECT id,customer_id AS "customerId",invoice_date AS "invoiceDate",due_date AS "dueDate",amount,currency,paid,outstanding,status FROM invoice_balances';
const paymentSelect=`SELECT p.id,p.customer_id AS "customerId",p.payment_date AS "paymentDate",p.amount,p.currency,p.reference,CASE WHEN a.id IS NOT NULL THEN 'allocated' ELSE p.review_status END AS status,p.review_status AS "reviewStatus",coalesce(a.explanation,p.explanation) AS explanation,p.candidates,CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'invoiceId',a.invoice_id,'amount',a.amount,'explanation',a.explanation) END AS allocation FROM payments p LEFT JOIN allocations a ON a.workspace_id=p.workspace_id AND a.payment_id=p.id AND a.reversed_at IS NULL`;
const auditSelect=`SELECT e.id,coalesce(p.name,'Reconciliation worker') AS actor,e.action,e.entity_id AS "entityId",e.explanation,e.changes,e.created_at AS "createdAt" FROM audit_events e LEFT JOIN principals p ON p.id::text=e.actor`;
export async function getState(ctx:Context,options:{view?:string;page?:number;search?:string;status?:string}={}) {
  const member=await requireMember(ctx);
  // One snapshot prevents a polling response mixing totals from opposite sides of a commit.
  return transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const workspace=(await c.query('SELECT id,name,currency FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    const totals=(await c.query(`SELECT (SELECT coalesce(sum(amount),0)::bigint FROM invoices WHERE workspace_id=$1) AS "invoiceTotal",(SELECT coalesce(sum(amount),0)::bigint FROM allocations WHERE workspace_id=$1 AND reversed_at IS NULL) AS "allocatedTotal",(SELECT coalesce(sum(amount),0)::bigint FROM payments WHERE workspace_id=$1) AS "paymentTotal",(SELECT count(*)::int FROM invoices WHERE workspace_id=$1) AS "invoiceCount",(SELECT count(*)::int FROM payments WHERE workspace_id=$1) AS "paymentCount",(SELECT count(*)::int FROM payments p WHERE workspace_id=$1 AND review_status<>'pending' AND NOT EXISTS(SELECT 1 FROM allocations a WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id AND a.reversed_at IS NULL)) AS "exceptionCount"`,[ctx.workspaceId])).rows[0];
    totals.outstandingTotal=totals.invoiceTotal-totals.allocatedTotal; totals.unallocatedTotal=totals.paymentTotal-totals.allocatedTotal;
    const run=(await c.query('SELECT id,status,processed,total,error,created_at AS "createdAt" FROM runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ctx.workspaceId])).rows[0]??null;
    const page=Math.max(1,Math.floor(options.page??1)),pageSize=options.view==='dashboard'?5:25;
    const values:unknown[]=[ctx.workspaceId]; let query:string;
    if(options.view==='invoices') query=`${invoiceSelect} WHERE workspace_id=$1`;
    else if(options.view==='imports') query='SELECT id,type,filename,row_count AS "rowCount",skipped,status,created_at AS "createdAt" FROM imports WHERE workspace_id=$1';
    else if(options.view==='audit') query=`${auditSelect} WHERE e.workspace_id=$1`;
    else query=`${paymentSelect} WHERE p.workspace_id=$1${['exceptions','dashboard',undefined].includes(options.view)?" AND a.id IS NULL AND p.review_status<>'pending'":''}`;
    query=`SELECT * FROM (${query}) data WHERE true`;
    if(options.search) {values.push(`%${options.search.replace(/[\\%_]/g,'\\$&')}%`);query+=` AND data::text ILIKE $${values.length}`;}
    if(options.status && options.view!=='audit') {values.push(options.status);query+=` AND status=$${values.length}`;}
    const total=(await c.query(`SELECT count(*)::int AS count FROM (${query}) counted`,values)).rows[0].count;
    const order=['imports','audit'].includes(options.view??'')?'"createdAt" DESC,id':'id';
    const rows=(await c.query(`${query} ORDER BY ${order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,pageSize,(page-1)*pageSize])).rows;
    return {workspace:{...workspace,role:member.role},totals,run,rows,total,page,pageSize};
  });
}
export async function getPayment(ctx:Context,id:string,search='') {
  await requireMember(ctx);
  const payment=(await pool.query(`${paymentSelect} WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,id])).rows[0];
  if(!payment) throw new AppError('Payment not found in your workspace.',404);
  const invoices=(await pool.query(`${invoiceSelect} WHERE workspace_id=$1 AND currency=$2 AND outstanding >= $3 AND ($4::text IS NULL OR customer_id=$4) AND (id ILIKE $5 OR customer_id ILIKE $5) ORDER BY id LIMIT 100`,[ctx.workspaceId,payment.currency,payment.amount,payment.customerId,`%${search.replace(/[\\%_]/g,'\\$&')}%`])).rows;
  const events=(await pool.query(`${auditSelect} WHERE e.workspace_id=$1 AND (e.entity_id=$2 OR e.changes->>'paymentId'=$2) ORDER BY e.created_at DESC LIMIT 100`,[ctx.workspaceId,id])).rows;
  return {payment,candidates:payment.candidates,invoices,audit:events};
}
function validateNote(note:string) { if(typeof note!=='string'||note.trim().length<3||note.length>2000) throw new AppError('Enter an explanation between 3 and 2,000 characters.',422); }
export async function allocate(ctx:Context,paymentId:string,invoiceId:string,note:string) {
  await requireMember(ctx,true);validateNote(note);
  return transaction(async c=>{
    await lockWorkspace(c,ctx,true);
    const p=(await c.query('SELECT * FROM payments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,paymentId])).rows[0];
    const i=(await c.query('SELECT * FROM invoice_balances WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,invoiceId])).rows[0];
    if(!p||!i) throw new AppError('Payment or invoice not found in your workspace.',404);
    if((await c.query('SELECT id FROM allocations WHERE workspace_id=$1 AND payment_id=$2 AND reversed_at IS NULL',[ctx.workspaceId,paymentId])).rowCount) throw new AppError('This payment has already been allocated. Refresh to see the latest decision.',409);
    if(p.currency!==i.currency||(p.customer_id&&p.customer_id!==i.customer_id)||p.amount>i.outstanding) throw new AppError('Invoice must have matching customer and currency, and enough outstanding balance.',409);
    const id=randomUUID();
    await c.query("INSERT INTO allocations(id,workspace_id,payment_id,invoice_id,amount,source,explanation,evidence) VALUES($1,$2,$3,$4,$5,'manual',$6,$7)",[id,ctx.workspaceId,paymentId,invoiceId,p.amount,note,JSON.stringify({outstandingBefore:i.outstanding,outstandingAfter:i.outstanding-p.amount})]);
    await c.query("UPDATE payments SET review_status='allocated',explanation=$3,candidates='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,paymentId,note]);
    await c.query("INSERT INTO decisions(id,workspace_id,principal_id,payment_id,allocation_id,action,note) VALUES($1,$2,$3,$4,$5,'allocated',$6)",[randomUUID(),ctx.workspaceId,ctx.principalId,paymentId,id,note]);
    await audit(c,ctx,'payment_allocated',paymentId,note,{paymentId,invoiceId,allocationId:id,amount:p.amount,outstandingBefore:i.outstanding,outstandingAfter:i.outstanding-p.amount});
    return {id};
  });
}
export async function reverse(ctx:Context,paymentId:string,note:string) {
  await requireMember(ctx,true);validateNote(note);
  return transaction(async c=>{
    await lockWorkspace(c,ctx,true);
    const a=(await c.query('SELECT * FROM allocations WHERE workspace_id=$1 AND payment_id=$2 AND reversed_at IS NULL',[ctx.workspaceId,paymentId])).rows[0];
    if(!a) throw new AppError('No active allocation found in your workspace.',404);
    await c.query('UPDATE allocations SET reversed_at=now(),reversal_note=$2 WHERE id=$1',[a.id,note]);
    await c.query("UPDATE payments SET review_status='reversed',explanation=$3,candidates='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,paymentId,note]);
    await c.query("INSERT INTO decisions(id,workspace_id,principal_id,payment_id,allocation_id,action,note) VALUES($1,$2,$3,$4,$5,'reversed',$6)",[randomUUID(),ctx.workspaceId,ctx.principalId,paymentId,a.id,note]);
    await audit(c,ctx,'allocation_reversed',paymentId,note,{paymentId,invoiceId:a.invoice_id,allocationId:a.id,restoredOutstanding:a.amount});return {id:a.id};
  });
}
export async function deferPayment(ctx:Context,paymentId:string,note:string) {
  await requireMember(ctx,true);validateNote(note);
  await transaction(async c=>{
    await lockWorkspace(c,ctx,true);
    if((await c.query('SELECT id FROM allocations WHERE workspace_id=$1 AND payment_id=$2 AND reversed_at IS NULL',[ctx.workspaceId,paymentId])).rowCount) throw new AppError('Reverse the allocation before leaving this payment unresolved.',409);
    if(!(await c.query("UPDATE payments SET review_status='deferred',explanation=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id",[ctx.workspaceId,paymentId,note])).rowCount) throw new AppError('Payment not found.',404);
    await c.query("INSERT INTO decisions(id,workspace_id,principal_id,payment_id,action,note) VALUES($1,$2,$3,$4,'deferred',$5)",[randomUUID(),ctx.workspaceId,ctx.principalId,paymentId,note]);
    await audit(c,ctx,'payment_deferred',paymentId,note);
  });return {ok:true};
}
export async function queueRun(ctx:Context) {
  await requireMember(ctx,true);const boss=await getBoss();
  return transaction(async c=>{
    await lockWorkspace(c,ctx);
    const existing=(await c.query("SELECT id,status FROM runs WHERE workspace_id=$1 AND status IN ('queued','running')",[ctx.workspaceId])).rows[0];
    if(existing) return existing;
    const recent=(await c.query("SELECT count(*)::int AS count FROM runs WHERE workspace_id=$1 AND created_at>now()-interval '1 hour'",[ctx.workspaceId])).rows[0].count;
    if(recent>=20) throw new AppError('Run limit reached (20 per hour). Please try again later.',429);
    const total=(await c.query('SELECT count(*)::int AS count FROM payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count;
    if(!total) throw new AppError('Import or load payments before running reconciliation.',422);
    const id=randomUUID();
    await c.query("INSERT INTO runs(id,workspace_id,principal_id,status,total,rule_version) VALUES($1,$2,$3,'queued',$4,$5)",[id,ctx.workspaceId,ctx.principalId,total,RULE_VERSION]);
    const jobId=await boss.send(QUEUE,{runId:id,workspaceId:ctx.workspaceId},{retryLimit:3,retryDelay:3,retryBackoff:true,expireInSeconds:3600,heartbeatSeconds:30,db:{executeSql:(sql,values)=>c.query(sql,values)}});
    await c.query('UPDATE runs SET job_id=$2 WHERE id=$1',[id,jobId]);
    await audit(c,ctx,'reconciliation_queued',id,'Queued reconciliation.',{jobId,ruleVersion:RULE_VERSION});return {id,status:'queued'};
  });
}
export async function processRun(runId:string,options:{failAfter?:number}={}) {
  const lease=await pool.connect();let locked=false;let ctx:Context|undefined;
  try {
    const run=(await lease.query('SELECT * FROM runs WHERE id=$1',[runId])).rows[0];
    if(!run||run.status==='completed') return;
    ctx={workspaceId:run.workspace_id,principalId:run.principal_id};
    locked=(await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[ctx.workspaceId])).rows[0].locked;
    if(!locked) throw new Error('A worker is already processing this workspace; retry later.');
    const claimed=await transaction(async c=>{
      await lockWorkspace(c,ctx!);
      return (await c.query("UPDATE runs SET status='running',attempts=attempts+1,error=NULL,updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id",[runId])).rowCount;
    });
    if(!claimed) return;
    const invoices=(await lease.query(`${invoiceSelect} WHERE workspace_id=$1`,[ctx.workspaceId])).rows as Invoice[];
    const payments=(await lease.query('SELECT id,customer_id AS "customerId",payment_date AS "paymentDate",amount,currency,reference,review_status AS "reviewStatus" FROM payments WHERE workspace_id=$1',[ctx.workspaceId])).rows as Payment[];
    const active=new Set<string>((await lease.query('SELECT payment_id FROM allocations WHERE workspace_id=$1 AND reversed_at IS NULL',[ctx.workspaceId])).rows.map(r=>r.payment_id));
    const result=reconcile(invoices,payments,active);
    let processed=active.size,committed=0;
    await lease.query('UPDATE runs SET processed=$2,total=$3 WHERE id=$1',[runId,processed,payments.length]);
    const effects=[...result.allocations.map(a=>({kind:'allocation' as const,value:a})),...result.reviews.map(r=>({kind:'review' as const,value:r}))];
    for(let offset=0;offset<effects.length;) {
      const batchSize=Math.min(100,options.failAfter?options.failAfter-committed:100);
      if(batchSize<=0) throw new Error('Injected worker interruption after committed batch.');
      const batch=effects.slice(offset,offset+batchSize);
      await transaction(async c=>{
        await lockWorkspace(c,ctx!);
        await fenceRun(c,runId);
        const allocations=batch.filter(e=>e.kind==='allocation').map(e=>({...e.value,id:randomUUID()}));
        if(allocations.length) {
          await c.query(`INSERT INTO allocations(id,workspace_id,payment_id,invoice_id,amount,source,rule_version,explanation,evidence,run_id) SELECT x.id,$1,x."paymentId",x."invoiceId",x.amount,'automatic',$2,x.explanation,x.evidence,$3 FROM jsonb_to_recordset($4::jsonb) AS x(id uuid,"paymentId" text,"invoiceId" text,amount bigint,explanation text,evidence jsonb)`,[ctx!.workspaceId,RULE_VERSION,runId,JSON.stringify(allocations)]);
          await c.query(`INSERT INTO audit_events(id,workspace_id,actor,action,entity_id,explanation,changes) SELECT gen_random_uuid(),$1,'worker','automatic_allocation',x."paymentId",x.explanation,to_jsonb(x) FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,"paymentId" text,"invoiceId" text,amount bigint,explanation text,evidence jsonb)`,[ctx!.workspaceId,JSON.stringify(allocations)]);
          await c.query("UPDATE payments SET review_status='allocated',candidates='[]' WHERE workspace_id=$1 AND id=ANY($2::text[])",[ctx!.workspaceId,allocations.map(a=>a.paymentId)]);
        }
        const reviews=batch.filter(e=>e.kind==='review').map(e=>e.value);
        if(reviews.length) await c.query(`UPDATE payments p SET review_status=x.status,explanation=CASE WHEN p.review_status IN ('reversed','deferred') THEN p.explanation ELSE x.explanation END,candidates=x.candidates FROM jsonb_to_recordset($2::jsonb) AS x("paymentId" text,status text,explanation text,candidates jsonb) WHERE p.workspace_id=$1 AND p.id=x."paymentId"`,[ctx!.workspaceId,JSON.stringify(reviews)]);
        processed+=batch.length;
        await c.query('UPDATE runs SET processed=$2,updated_at=now() WHERE id=$1',[runId,processed]);
      });
      committed+=batch.length;offset+=batch.length;
      if(process.env.QUIET_PROGRESS!=='true') console.log(JSON.stringify({event:'reconciliation_progress',workspaceId:ctx.workspaceId,runId,jobId:run.job_id,processed,total:payments.length}));
      if(options.failAfter&&committed>=options.failAfter) throw new Error('Injected worker interruption after committed batch.');
    }
    await transaction(async c=>{
      await lockWorkspace(c,ctx!);
      await fenceRun(c,runId);
      await c.query("UPDATE runs SET status='completed',processed=total,error=NULL,updated_at=now() WHERE id=$1",[runId]);
      await audit(c,ctx!,'reconciliation_completed',runId,`Reviewed ${payments.length} payments; ${result.allocations.length} new automatic allocations.`,{ruleVersion:RULE_VERSION,automaticAllocations:result.allocations.length,reviewCount:result.reviews.length});
    });
  } catch(error) {
    if(locked) await lease.query("UPDATE runs SET status='queued',error=$2,updated_at=now() WHERE id=$1 AND status='running'",[runId,error instanceof Error?error.message:'Worker failed.']);
    throw error;
  } finally {
    if(locked&&ctx) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[ctx.workspaceId]);lease.release();
  }
}
async function fenceRun(c:Client,runId:string) {
  const run=(await c.query('SELECT status FROM runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
  if(run?.status!=='running') throw new Error('This reconciliation is no longer active; no further effects were committed.');
}
export async function markRunFailed(runId:string,message:string) {
  return transaction(async c=>{
    const run=(await c.query('SELECT workspace_id FROM runs WHERE id=$1',[runId])).rows[0];
    if(!run) return;
    const {locked}=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[run.workspace_id])).rows[0];
    // An expired queue attempt must never unlock editing while an earlier worker is still applying batches.
    if(!locked) return;
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[run.workspace_id]);
    await c.query("UPDATE runs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",[runId,message]);
  });
}
export async function exportRecords(ctx:Context,type:string) {
  await requireMember(ctx);
  const query=type==='invoices'?`${invoiceSelect} WHERE workspace_id=$1 ORDER BY id`:type==='payments'?`${paymentSelect} WHERE p.workspace_id=$1 ORDER BY p.id`:type==='audit'?`${auditSelect} WHERE e.workspace_id=$1 ORDER BY e.created_at,e.id`:null;
  if(!query) throw new AppError('Choose invoices, payments or audit.');
  const rows=(await pool.query(query,[ctx.workspaceId])).rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,['amount','paid','outstanding'].includes(k)?formatMoney(Number(v)):v instanceof Date?v.toISOString():typeof v==='object'&&v!==null?JSON.stringify(v):v])));
  return csvStringify(rows);
}
