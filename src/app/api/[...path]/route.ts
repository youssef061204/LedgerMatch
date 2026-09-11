import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { context, sessionCookie } from '../../../server/auth';
import { pool, transaction } from '../../../server/db';
import { AppError, createWorkspace, requireMember, getState, seedWorkspace, queueRun, importRecords, getPayment, allocate, reverse, deferPayment, exportRecords, audit } from '../../../server/service';
import { parseCsv, csvStringify } from '../../../domain/csv';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const importSchema=z.object({type:z.enum(['invoice','payment']),filename:z.string().min(1).max(200),text:z.string().max(20*1024*1024),mapping:z.record(z.string(),z.string()).optional()});
const noteSchema=z.object({note:z.string().trim().min(3).max(2000)});
async function body(request:NextRequest) {
  const limit=24*1024*1024;
  if(Number(request.headers.get('content-length'))>limit) throw new AppError('Upload exceeds the 20 MiB CSV limit.',413);
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('Send JSON content.',415);
  const reader=request.body?.getReader();if(!reader) return {};
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done) break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new AppError('Upload exceeds the 20 MiB CSV limit.',413);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Invalid JSON request.',400);}
}
function download(text:string,filename:string) {return new NextResponse(text,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function handle(request:NextRequest,{params}:{params:Promise<{path:string[]}>}) {
  try {
    const {path}=await params;const route=path.join('/');const post=request.method==='POST';
    if(post) {
      const expected=new URL(process.env.APP_ORIGIN??'http://127.0.0.1:3000').origin;
      if(request.headers.get('origin')!==expected) throw new AppError('Request origin is not allowed.',403);
    }
    if(route==='health'&&!post){await pool.query('SELECT 1');return NextResponse.json({status:'ok'});}
    if(route==='demo'&&post) {
      try {const ctx=await context();await requireMember(ctx);return NextResponse.json({workspaceId:ctx.workspaceId});}catch(error){if(!(error instanceof AppError&&[401,403].includes(error.status))) throw error;}
      const recent=(await pool.query("SELECT count(*)::int AS count FROM workspaces WHERE created_at>now()-interval '1 hour'")).rows[0].count;
      if(recent>=500) throw new AppError('Demo creation limit reached. Please try again later.',429);
      const ctx=await createWorkspace();const session=await sessionCookie();session.id=ctx.sessionId;await session.save();return NextResponse.json({workspaceId:ctx.workspaceId});
    }
    const ctx=await context();const query=request.nextUrl.searchParams;
    if(!post) {
      if(route==='state') {const opts=z.object({view:z.enum(['dashboard','invoices','payments','exceptions','imports','audit']).default('dashboard'),page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().max(200).default(''),status:z.string().max(60).default('')}).parse(Object.fromEntries(query));return NextResponse.json(await getState(ctx,opts));}
      if(path[0]==='payments'&&path.length===2) return NextResponse.json(await getPayment(ctx,path[1],(query.get('search')??'').slice(0,200)));
      if(route==='export') return download(await exportRecords(ctx,query.get('type')??'payments'),`ledgermatch-${query.get('type')??'payments'}.csv`);
      if(route==='templates') {await requireMember(ctx);const type=z.enum(['invoice','payment']).parse(query.get('type'));return download(csvStringify(type==='invoice'?[{invoice_id:'INV-EXAMPLE',customer_id:'CUST-EXAMPLE',invoice_date:'2026-09-01',due_date:'2026-10-01',amount:'1250.00',currency:'CAD'}]:[{payment_id:'PAY-EXAMPLE',customer_id:'CUST-EXAMPLE',payment_date:'2026-09-10',amount:'1250.00',currency:'CAD',reference:'INV-EXAMPLE'}]),`${type}-template.csv`);}
    } else {
      await requireMember(ctx,true);const input=await body(request);
      if(route==='seed') {
        const {reset}=z.object({reset:z.boolean().default(false)}).parse(input);
        if(!reset) return NextResponse.json(await seedWorkspace(ctx));
        // Keep every earlier allocation and decision; expire only this session and switch to a fresh workspace.
        const next=await createWorkspace();await seedWorkspace(next);
        await transaction(async c=>{await audit(c,ctx,'workspace_archived',ctx.workspaceId,'Started a fresh synthetic demo; earlier records and decisions retained.',{newWorkspaceId:next.workspaceId});await c.query('UPDATE sessions SET expires_at=now() WHERE id=$1',[ctx.sessionId]);});
        const session=await sessionCookie();session.id=next.sessionId;await session.save();return NextResponse.json({workspaceId:next.workspaceId});
      }
      if(route==='runs') return NextResponse.json(await queueRun(ctx),{status:202});
      if(route==='imports/preview') {const parsed=importSchema.parse(input);const result=parseCsv(parsed.text,parsed.type,parsed.mapping);return NextResponse.json({headers:result.headers,preview:result.preview,errors:result.errors,mapping:result.mapping,recordCount:result.records.length});}
      if(route==='imports') return NextResponse.json(await importRecords(ctx,importSchema.parse(input)));
      if(path[0]==='payments'&&path.length===3) {
        const {note}=noteSchema.parse(input);
        if(path[2]==='allocate') {const {invoiceId}=z.object({invoiceId:z.string().min(1).max(200)}).parse(input);return NextResponse.json(await allocate(ctx,path[1],invoiceId,note));}
        if(path[2]==='reverse') return NextResponse.json(await reverse(ctx,path[1],note));
        if(path[2]==='defer') return NextResponse.json(await deferPayment(ctx,path[1],note));
      }
    }
    throw new AppError('This endpoint was not found.',404);
  } catch(error) {
    if(error instanceof AppError) return NextResponse.json({error:error.message,errors:error.errors},{status:error.status});
    if(error instanceof z.ZodError) return NextResponse.json({error:'Check the request fields.',errors:error.issues.map(i=>({field:i.path.join('.'),message:i.message}))},{status:422});
    console.error(JSON.stringify({event:'request_error',path:request.nextUrl.pathname,message:error instanceof Error?error.message:'Unexpected failure'}));
    return NextResponse.json({error:'The workspace service is temporarily unavailable. Please retry. If running locally, check that PostgreSQL and the worker are running.'},{status:503});
  }
}
export const GET=handle;
export const POST=handle;
