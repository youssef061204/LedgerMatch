import { parse } from "csv-parse/sync";
import type { Invoice, Payment } from "./matching";
import { parseMoney } from "./money";

export const MAX_CSV_BYTES = 20 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;
export const MAX_VALIDATION_ERRORS = 200;
export type ImportType = "invoice" | "payment";
export type InvoiceRecord = Omit<Invoice, "paid">;
export type PaymentRecord = Omit<Payment, "reviewStatus">;
export interface CsvError { row: number; field: string; message: string }
export interface CsvResult {
  headers: string[];
  preview: Record<string, string>[];
  records: (InvoiceRecord | PaymentRecord)[];
  /** Physical ending line for each corresponding canonical record. */
  rowNumbers: number[];
  errors: CsvError[];
  mapping: Record<string, string>;
}

export const CSV_FIELDS = {
  invoice: ["invoice_id", "customer_id", "invoice_date", "due_date", "amount", "currency"],
  payment: ["payment_id", "customer_id", "payment_date", "amount", "currency", "reference"],
} as const;

const aliases: Record<string, string[]> = {
  invoice_id: ["invoiceid", "invoicenumber", "invoiceno", "invoice", "id"],
  payment_id: ["paymentid", "paymentnumber", "paymentno", "transactionid", "id"],
  customer_id: ["customerid", "customer", "clientid", "client", "accountid"],
  invoice_date: ["invoicedate", "issuedate", "date"],
  due_date: ["duedate", "due"],
  payment_date: ["paymentdate", "transactiondate", "receiveddate", "date"],
  amount: ["amount", "total", "invoiceamount", "paymentamount"],
  currency: ["currency", "currencycode", "ccy"],
  reference: ["reference", "paymentreference", "remittance", "memo", "description"],
};

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

const normalizedHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Returns no importable records when any error exists: imports are all-or-nothing. */
export function parseCsv(text: string, type: ImportType, suppliedMapping?: Record<string, string>): CsvResult {
  const result: CsvResult = { headers: [], preview: [], records: [], rowNumbers: [], errors: [], mapping: {} };
  const error = (row: number, field: string, message: string) => {
    if (result.errors.length < MAX_VALIDATION_ERRORS) result.errors.push({ row, field, message });
  };
  if (type !== "invoice" && type !== "payment") {
    error(1, "file", "Choose an invoice or payment import.");
    return result;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) {
    error(1, "file", "File exceeds the 20 MiB upload limit.");
    return result;
  }
  let parsed: { record: string[]; info: { lines: number } }[];
  try {
    parsed = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 65_536,
      info: true,
    // csv-parse's no-columns overload does not express the info:true envelope.
    }) as unknown as typeof parsed;
  } catch (caught) {
    const problem = caught as Error & { lines?: number };
    error(problem.lines ?? 1, "file", `Malformed CSV: ${problem.message}`);
    return result;
  }
  // Delimiter-only and whitespace-only rows are blank, not financial records.
  parsed = parsed.filter(({ record }) => record.some((value) => value.trim() !== ""));
  if (parsed.length === 0) {
    error(1, "file", "The file is empty. Start with a downloadable CSV template.");
    return result;
  }
  const headerRecord = parsed[0];
  result.headers = headerRecord.record.map((value) => value.trim());
  if (result.headers.some((header) => !header)) error(headerRecord.info.lines, "headers", "Column names cannot be empty.");
  if (new Set(result.headers).size !== result.headers.length) {
    error(headerRecord.info.lines, "headers", "Column names must be unique.");
  }
  if (parsed.length - 1 > MAX_CSV_ROWS) {
    error(1, "file", `File exceeds the ${MAX_CSV_ROWS.toLocaleString("en-CA")} row limit.`);
    return result;
  }
  const fields = CSV_FIELDS[type];
  const optional = new Set(type === "payment" ? ["customer_id", "reference"] : []);
  for (const field of fields) {
    const detected = result.headers.find((header) => normalizedHeader(header) === normalizedHeader(field))
      ?? result.headers.find((header) => aliases[field].includes(normalizedHeader(header)));
    const selected = suppliedMapping && Object.prototype.hasOwnProperty.call(suppliedMapping, field)
      ? suppliedMapping[field] : detected;
    if (selected && result.headers.includes(selected)) result.mapping[field] = selected;
    else if (selected) error(headerRecord.info.lines, field, `Mapped column "${selected}" was not found.`);
    else if (!optional.has(field)) error(headerRecord.info.lines, field, `Missing required column: ${field}. Select its source column.`);
  }
  const mappedHeaders = Object.values(result.mapping);
  if (new Set(mappedHeaders).size !== mappedHeaders.length) {
    error(headerRecord.info.lines, "mapping", "Each source column may map to only one field.");
  }
  const headerPositions = new Map(result.headers.map((header, index) => [header, index]));
  const seenIds = new Map<string, number>();
  for (const { record, info } of parsed.slice(1)) {
    const row = info.lines;
    if (result.preview.length < 10) {
      result.preview.push(Object.fromEntries(result.headers.map((header, index) => [header, record[index] ?? ""])));
    }
    if (record.length !== result.headers.length) {
      error(row, "row", `Expected ${result.headers.length} columns but found ${record.length}. Check commas and quoting.`);
      continue;
    }
    const get = (field: string) => {
      const position = headerPositions.get(result.mapping[field]);
      return position === undefined ? "" : (record[position] ?? "").trim();
    };
    const errorsBefore = result.errors.length;
    let valid = true;
    const fail = (field: string, message: string) => { valid = false; error(row, field, message); };
    const identifier = (field: string, required: boolean) => {
      const value = get(field);
      if (!value && required) fail(field, "An identifier is required.");
      if (value.length > 120) fail(field, "Identifiers must be at most 120 characters.");
      if (/[\u0000-\u001f\u007f]/.test(value)) fail(field, "Identifiers cannot contain control characters.");
      return value;
    };
    const idField = type === "invoice" ? "invoice_id" : "payment_id";
    const id = identifier(idField, true);
    const customerId = identifier("customer_id", type === "invoice");
    if (id && seenIds.has(id)) fail(idField, `Duplicate identifier "${id}"; first seen on row ${seenIds.get(id)}.`);
    else if (id) seenIds.set(id, row);
    let amount = 0;
    try { amount = parseMoney(get("amount")); }
    catch (caught) { fail("amount", (caught as Error).message); }
    const currency = get("currency").toUpperCase();
    if (currency !== "CAD") fail("currency", "Only CAD is supported. A workspace uses one currency.");
    const dateField = type === "invoice" ? "invoice_date" : "payment_date";
    const date = get(dateField);
    if (!isIsoDate(date)) fail(dateField, "Use a valid calendar date in YYYY-MM-DD format.");
    if (type === "invoice") {
      const dueDate = get("due_date");
      if (!isIsoDate(dueDate)) fail("due_date", "Use a valid calendar date in YYYY-MM-DD format.");
      else if (isIsoDate(date) && dueDate < date) fail("due_date", "Due date cannot precede invoice date.");
      if (valid && result.errors.length === errorsBefore) {
        result.records.push({ id, customerId, invoiceDate: date, dueDate, amount, currency });
        result.rowNumbers.push(row);
      }
    } else {
      const reference = get("reference") || null;
      if (reference && (reference.length > 1_000 || reference.includes("\0"))) {
        fail("reference", "Reference must be at most 1,000 characters and cannot contain a null character.");
      }
      if (valid && result.errors.length === errorsBefore) {
        result.records.push({ id, customerId: customerId || null, paymentDate: date, amount, currency, reference });
        result.rowNumbers.push(row);
      }
    }
  }
  if (parsed.length === 1) error(headerRecord.info.lines, "file", "The file has headers but no data rows.");
  if (result.errors.length > 0) {
    result.records = [];
    result.rowNumbers = [];
  }
  return result;
}

/** Quotes every field and neutralizes spreadsheet formula prefixes, even after whitespace. */
export function csvStringify(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[\s\uFEFF]*[=+@\-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [headers.map(cell).join(","), ...rows.map((row) => headers.map((header) => cell(row[header])).join(","))].join("\r\n") + "\r\n";
}
