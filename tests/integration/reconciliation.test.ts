import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { pool } from "../../src/server/db";
import { allocate, createWorkspace, deferPayment, getPayment, getState, importRecords, processRun, queueRun, requireMember, reverse, seedWorkspace, markRunFailed } from "../../src/server/service";
import { PgBoss } from 'pg-boss';
import { RULE_VERSION } from "../../src/domain/matching";

type Context = { workspaceId: string; principalId: string };
const invoiceHeader = "invoice_id,customer_id,invoice_date,due_date,amount,currency\n";
const paymentHeader = "payment_id,customer_id,payment_date,amount,currency,reference\n";

async function invoices(ctx: Context, rows: string) {
  return importRecords(ctx, { type: "invoice", filename: "integration-invoices.csv", text: invoiceHeader + rows });
}
async function payments(ctx: Context, rows: string) {
  return importRecords(ctx, { type: "payment", filename: "integration-payments.csv", text: paymentHeader + rows });
}
async function manualFixture() {
  const ctx = await createWorkspace();
  await invoices(ctx, "INV-A,CUST-A,2026-09-01,2026-10-01,100.00,CAD\nINV-B,CUST-A,2026-09-01,2026-10-01,100.00,CAD\n");
  await payments(ctx, "PAY-A,CUST-A,2026-09-10,60.00,CAD,\nPAY-B,CUST-A,2026-09-10,60.00,CAD,\n");
  return ctx;
}
async function newRun(ctx: Context) {
  const id = randomUUID();
  await pool.query("INSERT INTO runs(id,workspace_id,principal_id,status,rule_version) VALUES($1,$2,$3,'queued',$4)", [id, ctx.workspaceId, ctx.principalId, RULE_VERSION]);
  return id;
}
async function activeAllocations(ctx: Context) {
  return (await pool.query("SELECT id,payment_id,invoice_id,amount FROM allocations WHERE workspace_id=$1 AND reversed_at IS NULL ORDER BY payment_id", [ctx.workspaceId])).rows;
}
async function assertInvariants(ctx: Context) {
  const { totals } = await getState(ctx, {});
  expect(totals.invoiceTotal).toBe(totals.allocatedTotal + totals.outstandingTotal);
  expect(totals.paymentTotal).toBe(totals.allocatedTotal + totals.unallocatedTotal);
  expect((await pool.query("SELECT id FROM invoice_balances WHERE workspace_id=$1 AND outstanding<0", [ctx.workspaceId])).rows).toEqual([]);
  expect((await pool.query("SELECT payment_id FROM allocations WHERE workspace_id=$1 AND reversed_at IS NULL GROUP BY payment_id HAVING count(*)>1", [ctx.workspaceId])).rows).toEqual([]);
}

// Deliberately retain uniquely identified test workspaces: no destructive global truncate,
// and historical evidence cannot be deleted through ordinary database writes.
afterAll(async () => { await pool.end(); });

test('terminal queue failure cannot release a workspace owned by an active worker',async()=>{
  const ctx=await createWorkspace();const run=await newRun(ctx);const lease=await pool.connect();
  try{
    await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[ctx.workspaceId]);
    await markRunFailed(run,'Expired attempt');
    expect((await getState(ctx)).run.status).toBe('queued');
  }finally{await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[ctx.workspaceId]);lease.release();}
  await markRunFailed(run,'Expired attempt');expect((await getState(ctx)).run.status).toBe('failed');
});

test('real durable queue retries a failed handler after committed effects without duplicate allocations',async()=>{
  const ctx=await createWorkspace();await seedWorkspace(ctx,false,12);const run=await newRun(ctx);
  const boss=new PgBoss({connectionString:process.env.DATABASE_URL});boss.on('error',()=>{});const queue=`test-${randomUUID()}`;
  let attempts=0;
  try{
    await boss.start();await boss.createQueue(queue,{retryLimit:2,retryDelay:1});
    await boss.work<{runId:string}>(queue,{pollingIntervalSeconds:0.5},async jobs=>{for(const job of jobs){attempts++;await processRun(job.data.runId,attempts===1?{failAfter:2}:{});}});
    const jobId=await boss.send(queue,{runId:run});
    await expect.poll(async()=>(await boss.getJobById(queue,jobId!))?.state,{timeout:20000,interval:250}).toBe('completed');
    expect(attempts).toBe(2);expect(await activeAllocations(ctx)).toHaveLength(5);await assertInvariants(ctx);
  }finally{await boss.stop({graceful:true});}
});

describe("PostgreSQL imports and authorization", () => {
  test("same file and reordered identical records do not duplicate records; conflicts reject the whole file", async () => {
    const ctx = await createWorkspace();
    const first = "INV-A,CUST-A,2026-09-01,2026-10-01,10.25,CAD\n";
    const second = "INV-B,CUST-B,2026-09-02,2026-10-02,30.50,CAD\n";
    await invoices(ctx, first + second);
    expect((await invoices(ctx, first + second)).duplicate).toBe(true);
    await invoices(ctx, second + first);
    const before = await getState(ctx, {});
    expect(before.totals.invoiceCount).toBe(2);
    expect(before.totals.invoiceTotal).toBe(4075);
    await expect(invoices(ctx, "INV-NEW,CUST-C,2026-09-01,2026-10-01,20.00,CAD\n" + first.replace("10.25", "10.26"))).rejects.toThrow();
    expect((await getState(ctx, {})).totals).toEqual(before.totals);
    expect((await pool.query("SELECT id FROM invoices WHERE workspace_id=$1 AND id='INV-NEW'", [ctx.workspaceId])).rowCount).toBe(0);
  });

  test("invalid input commits neither domain records nor import history", async () => {
    const ctx = await createWorkspace();
    await expect(invoices(ctx, "INV-A,CUST-A,2026-02-30,2026-10-01,10.001,CAD\n")).rejects.toThrow();
    expect((await getState(ctx, {})).totals.invoiceCount).toBe(0);
    expect((await pool.query("SELECT id FROM imports WHERE workspace_id=$1", [ctx.workspaceId])).rowCount).toBe(0);
  });

  test("memberships are checked on the server and viewers cannot mutate", async () => {
    const ctx = await manualFixture();
    await pool.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND principal_id=$2", [ctx.workspaceId, ctx.principalId]);
    expect((await getState(ctx, {})).totals.invoiceCount).toBe(2);
    await expect(allocate(ctx, "PAY-A", "INV-A", "Viewer attempt")).rejects.toThrow();
    await expect(invoices(ctx, "INV-X,CUST-A,2026-09-01,2026-10-01,10.00,CAD\n")).rejects.toThrow();
    await expect(seedWorkspace(ctx, true)).rejects.toThrow();
    await expect(deferPayment(ctx, "PAY-A", "Viewer attempt")).rejects.toThrow();
    await expect(reverse(ctx, "PAY-A", "Viewer attempt")).rejects.toThrow();
    await expect(queueRun(ctx)).rejects.toThrow();
    expect(await activeAllocations(ctx)).toEqual([]);
  });

  test("changing a workspace ID cannot borrow someone else's membership or records", async () => {
    const owner = await manualFixture();
    const other = await createWorkspace();
    const forged = { workspaceId: owner.workspaceId, principalId: other.principalId };
    await expect(requireMember(forged)).rejects.toThrow();
    await expect(getState(forged, {})).rejects.toThrow();
    await expect(getPayment(other, "PAY-A")).rejects.toThrow();
    await expect(allocate(forged, "PAY-A", "INV-A", "Cross-workspace attempt")).rejects.toThrow();
    await seedWorkspace(other, false, 12);
    expect((await getState(owner, {})).totals.invoiceCount).toBe(2);
    expect(await activeAllocations(owner)).toEqual([]);
  });
});

describe("PostgreSQL reconciliation, review and recovery", () => {
  test("a workspace has one active run and rejects mutations until its snapshot finishes", async () => {
    const ctx = await manualFixture();
    const runId = await newRun(ctx);
    await expect(newRun(ctx)).rejects.toThrow();
    await expect(allocate(ctx, "PAY-A", "INV-A", "Attempt during reconciliation")).rejects.toThrow();
    await expect(invoices(ctx, "INV-C,CUST-A,2026-09-01,2026-10-01,10.00,CAD\n")).rejects.toThrow();
    await processRun(runId);
    await deferPayment(ctx, "PAY-A", "Awaiting remittance evidence from the fictional customer");
    await processRun(await newRun(ctx));
    const detail = await getPayment(ctx, "PAY-A");
    expect(detail.payment.status).toBe("deferred");
    expect(detail.payment.explanation).toBe("Awaiting remittance evidence from the fictional customer");
    expect(await activeAllocations(ctx)).toEqual([]);
    await assertInvariants(ctx);
  });

  test("reference matches, partial balances and subsequent payments preserve accounting identities across reruns", async () => {
    const ctx = await createWorkspace();
    await seedWorkspace(ctx, false, 12);
    await processRun(await newRun(ctx));
    const original = await activeAllocations(ctx);
    expect(original.map((row) => row.payment_id)).toEqual(["PAY-1003", "PAY-1004", "PAY-1005", "PAY-1006", "PAY-1012"]);
    const balances = (await pool.query("SELECT id,paid,outstanding,status FROM invoice_balances WHERE workspace_id=$1 AND id IN ('INV-1004','INV-1005') ORDER BY id", [ctx.workspaceId])).rows;
    expect(balances).toEqual([
      { id: "INV-1004", paid: 100_000, outstanding: 0, status: "paid" },
      { id: "INV-1005", paid: 25_000, outstanding: 50_000, status: "partial" },
    ]);
    await processRun(await newRun(ctx));
    expect(await activeAllocations(ctx)).toEqual(original);
    await assertInvariants(ctx);
  });

  test("interruption after committed work safely repeats the run without duplicating effects", async () => {
    const ctx = await createWorkspace();
    await seedWorkspace(ctx, false, 12);
    const runId = await newRun(ctx);
    await expect(processRun(runId, { failAfter: 3 })).rejects.toThrow();
    const committed = await activeAllocations(ctx);
    expect(committed.length).toBeGreaterThan(0);
    await processRun(runId);
    const recovered = await activeAllocations(ctx);
    expect(recovered).toHaveLength(5);
    for (const allocation of committed) expect(recovered).toContainEqual(allocation);
    const run = (await pool.query("SELECT status,processed,total FROM runs WHERE id=$1", [runId])).rows[0];
    expect(run.status).toBe("completed");
    expect(run.processed).toBe(run.total);
    await assertInvariants(ctx);
  });

  test("two concurrent reviewers cannot allocate the same payment twice", async () => {
    const ctx = await manualFixture();
    const attempts = await Promise.allSettled([
      allocate(ctx, "PAY-A", "INV-A", "First concurrent decision"),
      allocate(ctx, "PAY-A", "INV-B", "Second concurrent decision"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await activeAllocations(ctx)).toHaveLength(1);
    expect((await pool.query("SELECT id FROM decisions WHERE workspace_id=$1", [ctx.workspaceId])).rowCount).toBe(1);
    await assertInvariants(ctx);
  });

  test("concurrent payments cannot exceed an invoice's outstanding amount", async () => {
    const ctx = await manualFixture();
    const attempts = await Promise.allSettled([
      allocate(ctx, "PAY-A", "INV-A", "First payment"),
      allocate(ctx, "PAY-B", "INV-A", "Second payment"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await activeAllocations(ctx)).toHaveLength(1);
    expect((await pool.query("SELECT outstanding FROM invoice_balances WHERE workspace_id=$1 AND id='INV-A'", [ctx.workspaceId])).rows[0].outstanding).toBe(4000);
    await assertInvariants(ctx);
  });

  test("an audit write failure rolls back the allocation and review decision atomically", async () => {
    const ctx = await manualFixture();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_audit_failure_${suffix}`;
    const triggerName = `test_audit_failure_${suffix}`;
    const before = (await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE workspace_id=$1", [ctx.workspaceId])).rows[0].count;
    // Identifiers and UUID are generated locally, not derived from input.
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${ctx.workspaceId}'::uuid THEN RAISE EXCEPTION 'Integration injected audit failure'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(allocate(ctx, "PAY-A", "INV-A", "Atomic failure fixture")).rejects.toThrow("Integration injected audit failure");
      expect(await activeAllocations(ctx)).toEqual([]);
      expect((await pool.query("SELECT id FROM decisions WHERE workspace_id=$1", [ctx.workspaceId])).rowCount).toBe(0);
      expect((await pool.query("SELECT count(*)::integer AS count FROM audit_events WHERE workspace_id=$1", [ctx.workspaceId])).rows[0].count).toBe(before);
      await assertInvariants(ctx);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
  });

  test("reversal restores balances, retains evidence, and requires intentional reallocation", async () => {
    const ctx = await createWorkspace();
    await invoices(ctx, "INV-A,CUST-A,2026-09-01,2026-10-01,100.00,CAD\n");
    await payments(ctx, "PAY-A,CUST-A,2026-09-10,60.00,CAD,INV-A\n");
    await processRun(await newRun(ctx));
    const before = await activeAllocations(ctx);
    expect(before).toHaveLength(1);
    await expect(reverse(ctx, "PAY-A", " ")).rejects.toThrow();
    await reverse(ctx, "PAY-A", "Remittance needs independent review");
    expect(await activeAllocations(ctx)).toEqual([]);
    const historical = (await pool.query("SELECT reversed_at,reversal_note FROM allocations WHERE id=$1", [before[0].id])).rows[0];
    expect(historical.reversed_at).toBeTruthy();
    expect(historical.reversal_note).toBe("Remittance needs independent review");
    await processRun(await newRun(ctx));
    expect(await activeAllocations(ctx)).toEqual([]);
    await allocate(ctx, "PAY-A", "INV-A", "Evidence now confirmed by reviewer");
    const current = await activeAllocations(ctx);
    expect(current).toHaveLength(1);
    expect(current[0].id).not.toBe(before[0].id);
    await assertInvariants(ctx);
  });

  test("database guards reject incompatible records and direct over-allocation", async () => {
    const ctx = await manualFixture();
    const other = await createWorkspace();
    await invoices(other, "INV-FOREIGN,CUST-A,2026-09-01,2026-10-01,100.00,CAD\n");
    await allocate(ctx, "PAY-A", "INV-A", "Allocate first payment");
    const rawAllocation = (payment: string, invoice: string, amount: number) => pool.query("INSERT INTO allocations(id,workspace_id,payment_id,invoice_id,amount,source,explanation,evidence) VALUES($1,$2,$3,$4,$5,'manual','Direct constraint test','{}')", [randomUUID(), ctx.workspaceId, payment, invoice, amount]);
    await expect(rawAllocation("PAY-B", "INV-A", 6000)).rejects.toThrow();
    await expect(rawAllocation("PAY-A", "INV-B", 6000)).rejects.toThrow();
    await expect(rawAllocation("PAY-B", "INV-B", 3000)).rejects.toThrow();
    await expect(rawAllocation("PAY-B", "INV-DOES-NOT-EXIST", 6000)).rejects.toThrow();
    await expect(rawAllocation("PAY-B", "INV-FOREIGN", 6000)).rejects.toThrow();
    expect(await activeAllocations(ctx)).toHaveLength(1);
    await assertInvariants(ctx);
  });
});
