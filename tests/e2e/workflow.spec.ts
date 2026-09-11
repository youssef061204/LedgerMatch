import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try demo" }).click();
  await expect(page.getByRole("heading", { name: "A clearer picture. A cleaner close." })).toBeVisible();
}

async function state(page: Page) {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("demo: durable reconciliation, review, balances, audit, export, and isolated sessions", async ({ page, browser }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await enterDemo(page);
  await expect(page.getByRole("heading", { name: "Your next close starts here." })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-empty.png"), fullPage: true });
  await page.getByRole("button", { name: "Load sample data", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Run reconciliation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run reconciliation", exact: true }).click();
  // A real independently running worker must consume the durable queue.
  await expect.poll(async () => (await state(page)).run?.status, { timeout: 90_000 }).toBe("completed");
  await expect(page.getByRole("button", { name: "Run reconciliation", exact: true })).toBeEnabled();
  const before = await state(page);
  expect(before.totals.allocatedTotal).toBeGreaterThan(0);
  expect(before.totals.exceptionCount).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("desktop-dashboard.png"), fullPage: true });

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Exceptions/ }).click();
  await page.getByRole("textbox", { name: "Search records" }).fill("PAY-1001");
  await page.getByRole("button", { name: "Review payment PAY-1001", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "PAY-1001", exact: true });
  await expect(dialog.getByRole("heading", { name: "Suggested invoices" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^INV-1001 / })).toBeVisible();
  await dialog.getByLabel("Invoice to allocate").selectOption("INV-1001");
  await dialog.getByLabel("Review note").fill("Synthetic remittance checked: the intended invoice is INV-1001.");
  await dialog.getByRole("button", { name: "Allocate payment", exact: true }).click();
  await expect(dialog.getByText("Allocated to INV-1001", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Synthetic remittance checked: the intended invoice is INV-1001.", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-resolved.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const after = await state(page);
  expect(after.totals.allocatedTotal).toBe(before.totals.allocatedTotal + 125_000);
  expect(after.totals.outstandingTotal).toBe(before.totals.outstandingTotal - 125_000);
  expect(after.totals.unallocatedTotal).toBe(before.totals.unallocatedTotal - 125_000);
  expect(after.totals.invoiceTotal).toBe(after.totals.allocatedTotal + after.totals.outstandingTotal);
  expect(after.totals.paymentTotal).toBe(after.totals.allocatedTotal + after.totals.unallocatedTotal);

  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  const formatted = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(after.totals.allocatedTotal / 100);
  await expect(page.locator(".metric-card").filter({ hasText: "Payments allocated" }).locator(".metric-value")).toContainText(formatted);
  await page.getByRole("navigation").getByRole("button", { name: "Audit trail", exact: true }).click();
  await page.getByRole("textbox", { name: "Search audit history" }).fill("PAY-1001");
  await expect(page.getByRole("table")).toContainText("Synthetic remittance checked: the intended invoice is INV-1001.");

  await page.getByRole("navigation").getByRole("button", { name: "Reconciliation", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export results", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = await readFile(downloadPath!, "utf8");
  expect(exported).toContain("PAY-1001");
  expect(exported).toContain("INV-1001");

  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const otherPage = await other.newPage();
  await enterDemo(otherPage);
  const otherState = await state(otherPage);
  expect(otherState.workspace.id).not.toBe(after.workspace.id);
  expect(otherState.totals.invoiceCount).toBe(0);
  expect((await otherPage.request.get("/api/payments/PAY-1001")).status()).toBe(404);
  await other.close();
  expect(consoleErrors).toEqual([]);
});

test("CSV mapping previews errors, rejects invalid records, and imports corrected data", async ({ page }, testInfo) => {
  await enterDemo(page);
  await page.getByRole("navigation").getByRole("button", { name: "Imports", exact: true }).click();
  const header = "Bill,Client,Issued,Due,Total,Currency\n";
  await page.getByLabel("Choose CSV file").setInputFiles({
    name: "invalid-invoices.csv", mimeType: "text/csv",
    buffer: Buffer.from(header + "INV-BROWSER,CUST-BROWSER,2026-02-30,2026-10-01,-10.00,CAD\n"),
  });
  const mapping = { invoice_id: "Bill", customer_id: "Client", invoice_date: "Issued", due_date: "Due", amount: "Total", currency: "Currency" };
  for (const [field, column] of Object.entries(mapping)) await page.getByLabel(`Map ${field}`, { exact: true }).selectOption(column);
  await page.getByRole("button", { name: "Validate mapping" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No records will be imported" })).toContainText("No records will be imported");
  await expect(page.getByRole("alert").filter({ hasText: "No records will be imported" })).toContainText("Row 2");
  await expect(page.getByRole("button", { name: /^Import \d+ records$/ })).toBeDisabled();
  expect((await state(page)).totals.invoiceCount).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("desktop-validation.png"), fullPage: true });
  await page.getByLabel("Choose CSV file").setInputFiles({
    name: "valid-invoices.csv", mimeType: "text/csv",
    buffer: Buffer.from(header + "INV-BROWSER,CUST-BROWSER,2026-09-01,2026-10-01,10.25,CAD\n"),
  });
  for (const [field, column] of Object.entries(mapping)) await page.getByLabel(`Map ${field}`, { exact: true }).selectOption(column);
  await page.getByRole("button", { name: "Validate mapping" }).click();
  await expect(page.getByText("Ready to import", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import 1 records", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("valid-invoices.csv");
  expect((await state(page)).totals.invoiceTotal).toBe(1025);
});

test("mobile workspace supports navigation and a readable empty state", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("mobile-dashboard.png"), fullPage: true });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Imports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import a CSV" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-imports.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('reversal survives rerun, reset isolates fresh state, and foreign origins are rejected',async({page})=>{
  await enterDemo(page);
  expect((await page.request.post('/api/seed',{headers:{Origin:'https://untrusted.example'},data:{}})).status()).toBe(403);
  await page.getByRole('button',{name:'Load sample data',exact:true}).first().click();
  await page.getByRole('button',{name:'Run reconciliation',exact:true}).click();
  await expect.poll(async()=>(await state(page)).run?.status,{timeout:90000}).toBe('completed');
  const before=await state(page);
  await page.getByRole('navigation').getByRole('button',{name:'Reconciliation',exact:true}).click();
  await page.getByRole('textbox',{name:'Search records'}).fill('PAY-1003');
  await page.getByRole('button',{name:'Review payment PAY-1003',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'PAY-1003',exact:true});
  await dialog.getByLabel('Reason for reversal').fill('Synthetic reviewer correction; preserve this evidence.');
  await dialog.getByRole('button',{name:'Reverse allocation',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Allocate payment',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Close dialog'}).click();
  expect((await state(page)).totals.allocatedTotal).toBe(before.totals.allocatedTotal-48000);
  await page.getByRole('button',{name:'Run reconciliation',exact:true}).click();
  await expect.poll(async()=>{const s=await state(page);return s.run?.id!==before.run.id&&s.run?.status==='completed';},{timeout:90000}).toBe(true);
  const payment=await (await page.request.get('/api/payments/PAY-1003')).json();
  expect(payment.payment.status).toBe('reversed');expect(payment.payment.allocation).toBeNull();
  expect(payment.audit.some((e:{action:string})=>e.action==='allocation_reversed')).toBe(true);
  await page.getByRole('button',{name:'Reset demo data',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Reset demo data',exact:true}).click();
  await expect.poll(async()=>(await state(page)).workspace.id).not.toBe(before.workspace.id);
  expect((await state(page)).totals.allocatedTotal).toBe(0);
});
