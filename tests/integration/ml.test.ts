import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { pool } from '../../src/server/db';
import { createWorkspace, importRecords, processRun, getPayment, getState, allocate, deferPayment, type Context } from '../../src/server/service';
import { csvStringify } from '../../src/domain/csv';
import { formatMoney } from '../../src/domain/money';
import { RULE_VERSION } from '../../src/domain/matching';
import { generateSample } from '../../src/ml/dataset';

afterAll(async()=>{await pool.end();});
async function run(ctx:Context,mlEnabled=true) {
  const id=randomUUID();await pool.query("INSERT INTO runs(id,workspace_id,principal_id,status,rule_version) VALUES($1,$2,$3,'queued',$4)",[id,ctx.workspaceId,ctx.principalId,RULE_VERSION]);
  await processRun(id,{mlEnabled});
}
async function fixture(scenario:'punctuation'|'clean'|'incorrect_customer'|'duplicate_looking') {
  const sample=generateSample(500,0,42,false,scenario),ctx=await createWorkspace();
  await importRecords(ctx,{type:'invoice',filename:'ml-invoices.csv',text:csvStringify(sample.invoices.map(i=>({invoice_id:i.id,customer_id:i.customerId,invoice_date:i.invoiceDate,due_date:i.dueDate,amount:formatMoney(i.amount),currency:i.currency})))});
  const p=sample.payment;
  await importRecords(ctx,{type:'payment',filename:'ml-payments.csv',text:csvStringify([{payment_id:p.id,customer_id:p.customerId??'',payment_date:p.paymentDate,amount:formatMoney(p.amount),currency:p.currency,reference:p.reference??''}])});
  return {sample,ctx};
}
test('ML exception predictions persist, require human confirmation, and retain financial invariants',async()=>{
  const {sample,ctx}=await fixture('punctuation');await run(ctx);
  const detail=await getPayment(ctx,sample.payment.id);
  expect(detail.payment.allocation).toBeNull();expect(detail.payment.recommendation.modelId).toMatch(/^lm-/);
  expect(detail.candidates[0].invoiceId).toBe(sample.trueInvoiceId);
  expect(detail.candidates[0].reasons.join(' ')).toContain('Reference similarity');
  expect((await getState(ctx)).totals.allocatedTotal).toBe(0);
  await allocate(ctx,sample.payment.id,sample.trueInvoiceId!,'Human confirmed synthetic remittance');
  const after=await getPayment(ctx,sample.payment.id);expect(after.payment.recommendation).toBeNull();
  const {totals}=await getState(ctx);expect(totals.invoiceTotal).toBe(totals.allocatedTotal+totals.outstandingTotal);expect(totals.paymentTotal).toBe(totals.allocatedTotal+totals.unallocatedTotal);
});
test('deterministic matches bypass ranking and disabling ML preserves heuristic review',async()=>{
  const exact=await fixture('clean');await run(exact.ctx);
  const p=(await getPayment(exact.ctx,exact.sample.payment.id)).payment;
  expect(p.allocation.invoiceId).toBe(exact.sample.trueInvoiceId);expect(p.recommendation).toBeNull();
  const ambiguous=await fixture('punctuation');await run(ambiguous.ctx,false);
  const detail=await getPayment(ambiguous.ctx,ambiguous.sample.payment.id);expect(detail.payment.recommendation).toBeNull();expect(detail.candidates.every((c:{mlScore?:number})=>c.mlScore===undefined)).toBe(true);
});
test('no-compatible-candidate and human-held cases abstain across reruns',async()=>{
  const unmatched=await fixture('incorrect_customer');await run(unmatched.ctx);
  const detail=await getPayment(unmatched.ctx,unmatched.sample.payment.id);expect(detail.candidates).toEqual([]);expect(detail.payment.recommendation.state).toBe('abstained');
  const held=await fixture('punctuation');await run(held.ctx);await deferPayment(held.ctx,held.sample.payment.id,'Await independent remittance evidence');await run(held.ctx);
  expect((await getPayment(held.ctx,held.sample.payment.id)).payment.recommendation.state).toBe('abstained');
  expect((await getState(held.ctx)).totals.allocatedTotal).toBe(0);
});

test('a competing human allocation invalidates stale visible recommendations',async()=>{
  const {sample,ctx}=await fixture('punctuation');const p=sample.payment;
  await importRecords(ctx,{type:'payment',filename:'competing-payment.csv',text:csvStringify([{payment_id:'PAY-COMPETING',customer_id:p.customerId!,payment_date:new Date(Date.parse(p.paymentDate)+86400000).toISOString().slice(0,10),amount:formatMoney(p.amount),currency:p.currency,reference:p.reference!}])});
  await run(ctx);
  expect((await getPayment(ctx,p.id)).candidates[0].invoiceId).toBe(sample.trueInvoiceId);
  await allocate(ctx,'PAY-COMPETING',sample.trueInvoiceId!,'Independent evidence confirms competing payment');
  const updated=await getPayment(ctx,p.id);
  expect(updated.candidates.some((c:{invoiceId:string})=>c.invoiceId===sample.trueInvoiceId)).toBe(false);
  expect(updated.payment.recommendation.state).toBe('abstained');
  expect(updated.payment.recommendation.reason).toContain('balances changed');
  expect(updated.payment.allocation).toBeNull();
});
