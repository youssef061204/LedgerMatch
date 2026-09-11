import { describe, expect, it } from "vitest";
import { csvStringify, isIsoDate, MAX_CSV_BYTES, MAX_CSV_ROWS, parseCsv } from "../../src/domain/csv";

const invoiceHeader = "invoice_id,customer_id,invoice_date,due_date,amount,currency";
const invoice = "INV-1,CUST-1,2024-02-29,2024-03-01,12.34,CAD";
const invoiceCsv = `${invoiceHeader}\n${invoice}`;

describe("CSV import validation", () => {
  it("autodetects canonical headers and creates exact camelCase records", () => {
    const result = parseCsv(invoiceCsv, "invoice");
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([{ id: "INV-1", customerId: "CUST-1", invoiceDate: "2024-02-29", dueDate: "2024-03-01", amount: 1234, currency: "CAD" }]);
    expect(result.mapping.invoice_id).toBe("invoice_id");
    expect(result.preview[0].amount).toBe("12.34");
    expect(result.rowNumbers).toEqual([2]);
  });
  it("autodetects common human-readable headers", () => {
    const result = parseCsv(`Invoice Number,Customer,Issue Date,Due,Total,CCY\n${invoice}`, "invoice");
    expect(result.errors).toEqual([]);
    expect(result.mapping.invoice_id).toBe("Invoice Number");
  });
  it("uses explicit mapping and allows absent optional payment fields", () => {
    const result = parseCsv("record,when,sum,unit\nP1,2026-09-01,100.01,cad", "payment", {
      payment_id: "record", payment_date: "when", amount: "sum", currency: "unit",
    });
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([{ id: "P1", customerId: null, reference: null, paymentDate: "2026-09-01", amount: 10001, currency: "CAD" }]);
  });
  it("rejects required columns, invalid mapping and repeated source mappings", () => {
    expect(parseCsv("invoice_id\nINV-1", "invoice").errors.some((error) => error.field === "amount")).toBe(true);
    expect(parseCsv(invoiceCsv, "invoice", { amount: "absent" }).errors.some((error) => error.message.includes("was not found"))).toBe(true);
    expect(parseCsv(invoiceCsv, "invoice", { customer_id: "invoice_id" }).errors.some((error) => error.field === "mapping")).toBe(true);
    expect(parseCsv(invoiceCsv, "invoice", { amount: "" }).records).toEqual([]);
  });
  it("rejects duplicate headers instead of silently replacing a value", () => {
    const result = parseCsv("payment_id,payment_date,amount,currency,amount\nP1,2026-01-01,10,CAD,11", "payment");
    expect(result.errors.some((error) => error.message.includes("unique"))).toBe(true);
    expect(result.records).toEqual([]);
  });
  it("handles BOM, blank lines, quoted commas, escaped quotes and multiline fields", () => {
    const result = parseCsv('\uFEFFpayment_id,payment_date,amount,currency,reference\n\n  \nP1,2026-09-01,12.34,CAD,"Wire, ""September""\nINV-1"\n,,,,\n', "payment");
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toHaveProperty("reference", 'Wire, "September"\nINV-1');
  });
  it("rejects the complete file when one row is invalid and reports its physical line", () => {
    const result = parseCsv(`${invoiceCsv}\n\nINV-2,CUST-1,2023-02-29,2024-03-01,12.34,CAD`, "invoice");
    expect(result.errors).toContainEqual({ row: 4, field: "invoice_date", message: "Use a valid calendar date in YYYY-MM-DD format." });
    expect(result.records).toEqual([]);
    expect(result.rowNumbers).toEqual([]);
    expect(result.preview).toHaveLength(2);
  });
  it("keeps canonical records aligned with physical lines after blank and multiline records", () => {
    const result = parseCsv('payment_id,payment_date,amount,currency,reference\n\nP1,2026-09-01,12.34,CAD,"First line\nSecond line"\n,,,,\n\nP2,2026-09-02,56.78,CAD,INV-2\n', "payment");
    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.id)).toEqual(["P1", "P2"]);
    expect(result.rowNumbers).toEqual([4, 7]);
    expect(result.rowNumbers).toHaveLength(result.records.length);
  });
  it("preserves invoice source lines when blank rows separate valid records", () => {
    const result = parseCsv(`${invoiceHeader}\n\n${invoice}\n\n${invoice.replace("INV-1", "INV-2")}\n`, "invoice");
    expect(result.errors).toEqual([]);
    expect(result.rowNumbers).toEqual([3, 5]);
  });
  it.each(["0", "-12.00", "1.234", "1e3", "100000000.01"])("rejects amount %s", (amount) => {
    const result = parseCsv(invoiceCsv.replace("12.34", amount), "invoice");
    expect(result.errors.some((error) => error.field === "amount")).toBe(true);
    expect(result.records).toEqual([]);
  });
  it("rejects missing identifiers, unsupported currency and inverted dates", () => {
    expect(parseCsv(invoiceCsv.replace("INV-1", ""), "invoice").errors.some((error) => error.field === "invoice_id")).toBe(true);
    expect(parseCsv(invoiceCsv.replace("CAD", "USD"), "invoice").errors.some((error) => error.field === "currency")).toBe(true);
    expect(parseCsv(invoiceCsv.replace("2024-03-01", "2024-01-01"), "invoice").errors.some((error) => error.field === "due_date")).toBe(true);
  });
  it("reports within-file duplicate IDs with the first row", () => {
    const result = parseCsv(`${invoiceCsv}\n${invoice}`, "invoice");
    expect(result.errors).toContainEqual({ row: 3, field: "invoice_id", message: 'Duplicate identifier "INV-1"; first seen on row 2.' });
    expect(result.records).toEqual([]);
  });
  it("rejects malformed quoting and wrong column counts", () => {
    expect(parseCsv(`${invoiceHeader}\n"unclosed`, "invoice").errors[0].message).toContain("Malformed CSV");
    expect(parseCsv(`${invoiceCsv},extra`, "invoice").errors.some((error) => error.message.includes("Expected 6 columns but found 7"))).toBe(true);
    expect(parseCsv(`${invoiceHeader}\nINV-1,CUST-1`, "invoice").records).toEqual([]);
  });
  it("provides useful empty and header-only errors", () => {
    expect(parseCsv("\n", "invoice").errors[0].message).toContain("empty");
    expect(parseCsv(invoiceHeader, "invoice").errors[0].message).toContain("no data rows");
  });
  it("bounds the preview and error response while rejecting every invalid row", () => {
    const result = parseCsv(`${invoiceHeader}\n${Array.from({ length: 250 }, (_, index) => `INV-${index},C,2026-01-01,2026-01-01,0,CAD`).join("\n")}`, "invoice");
    expect(result.preview).toHaveLength(10);
    expect(result.errors).toHaveLength(200);
    expect(result.records).toEqual([]);
  });
  it("enforces UTF-8 byte size before parsing", () => {
    const result = parseCsv("é".repeat(Math.floor(MAX_CSV_BYTES / 2) + 1), "invoice");
    expect(result.errors[0].message).toContain("20 MiB");
  });
  it("enforces maximum record count before generating records", () => {
    const result = parseCsv(`payment_id,payment_date,amount,currency\n${"P1,2026-01-01,1,CAD\n".repeat(MAX_CSV_ROWS + 1)}`, "payment");
    expect(result.errors[0].message).toContain("100,000 row limit");
    expect(result.records).toEqual([]);
  });
});

describe("calendar and safe export", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-12-31", "0001-01-01"])("accepts real date %s", (date) => expect(isIsoDate(date)).toBe(true));
  it.each(["2023-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "0000-01-01", "2026-1-01", "2026-01-00"])("rejects nonexistent date %s", (date) => expect(isIsoDate(date)).toBe(false));
  it("neutralizes formula-like data and headers and correctly quotes commas/newlines", () => {
    const output = csvStringify([{ "=SUM(A1)": "  =HYPERLINK(1)", plus: "+1", minus: "-1", at: "@SUM(1)", tab: "\tformula", text: 'A, "B"\nC', empty: null }]);
    expect(output).toContain('"\'=SUM(A1)"');
    expect(output).toContain('"\'  =HYPERLINK(1)"');
    expect(output).toContain('"\'+1"');
    expect(output).toContain('"\'-1"');
    expect(output).toContain('"\'@SUM(1)"');
    expect(output).toContain('"\'\tformula"');
    expect(output).toContain('"A, ""B""\nC"');
    expect(output.endsWith("\r\n")).toBe(true);
  });
});
