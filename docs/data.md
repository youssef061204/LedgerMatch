# Synthetic data and import policy

All fixtures are generated locally for this portfolio demonstration. Customer labels, invoice IDs, payment IDs and transactions are fictional. No bank accounts, real customers, external financial datasets or personal information are used. Dates are fixed in September 2026, amounts are CAD and balances start at zero paid.

`src/domain/fixtures.ts` exports `generateSmallFixture()` and `generateFixture(size = 240, seed = 42)`. The latter uses a seeded Mulberry32 generator for invoice amounts and dates. `size` is the invoice count, with a supported range of 12 to 1,000,000 for generation. Import limits still apply separately. The common sizes 240, 1,000, 10,000 and 100,000 have an equal number of payments and invoices; other requested sizes can have slightly different payment counts because partial payments and missing payments come in scenarios. Benchmarks must report the actual lengths of both arrays.

## Hand-checkable fixture

There are 12 invoices and 12 payments. Its five independently specified eligible automatic allocations total CAD 2,570.00; seven payments require review. Examples include:

| Payment | Expected behavior |
| --- | --- |
| PAY-1001, CAD 1,250.00 | Missing reference. CUST-MAPLE has INV-1001 and INV-1002 for the same amount; review both candidates. |
| PAY-1003, CAD 480.00 | `Remittance: inv-1003` resolves to INV-1003 and settles it. |
| PAY-1004, CAD 400.00; PAY-1005, CAD 600.00 | Successive payments settle INV-1004, whose total is CAD 1,000.00. |
| PAY-1006, CAD 250.00 | Partially pays INV-1005, leaving CAD 500.00 outstanding. |
| PAY-1007, CAD 700.00 | Exceeds INV-1007’s CAD 600.00 outstanding balance. |
| PAY-1008, CAD 900.00 | Supplied customer differs from INV-1008’s customer. |
| PAY-1009 and PAY-1010, CAD 300.00 each | Identical business fields and distinct IDs. Both require duplicate review. |
| PAY-1011, CAD 550.00 | Unknown reference; INV-1010 is suggested using compatible evidence. |
| PAY-1012, CAD 840.00 | Unique INV-1011 reference with no supplied customer; valid automatic allocation. |
| PAY-1013, CAD 360.00 | Reference names INV-1010 and INV-1012; requires review. |

INV-1006 has no incoming payment. Invoice totals remain separate from unresolved payment totals; an unknown or duplicate payment is not silently applied to an outstanding invoice.

Larger fixtures preserve these examples and append a repeating mix of exact, partial, subsequent, missing, unknown-reference, customer-mismatch, overpayment, reference-free and duplicate scenarios. Fixture generation never calls the matcher.

## Ground truth and metrics

The `truth` array is authored separately from matcher input fields. It contains only the unambiguous, automation-eligible payment/invoice pairs established by the scenario design. `reviewPaymentIds` independently lists the payments intentionally withheld from automation. These labels are not passed to the matching function.

Automatic-match precision is the number of proposed allocation pairs present in `truth`, divided by all automatic proposals. Eligible-match recall is those correct proposals divided by the number of pairs in `truth`. This denominator deliberately excludes missing-reference, ambiguous, invalid and suspicious duplicate cases; it measures recovery of eligible automatic matches, not the fraction of every payment automatically processed. Also report automated coverage over all payments and review counts so the restricted denominator is visible. Empty denominators should be reported as not applicable, not treated as evidence of perfect performance. A false automatic match is still a false positive even when it appears in a review scenario.

For import idempotency testing, reuse an identical CSV, reorder the same records, and change an amount while retaining its ID. Repeated-file and conflicting-ID behavior is enforced by the persistence layer and its integration tests, not by generating labels from matching output.

## CSV contract

Canonical invoice headers are `invoice_id,customer_id,invoice_date,due_date,amount,currency`. Canonical payment headers are `payment_id,customer_id,payment_date,amount,currency,reference`; payment customer and reference are optional. The parser provides a preview of up to ten records, sensible header aliases and explicit canonical-to-source column mapping. One source column cannot populate multiple canonical fields.

Files are UTF-8 CSV with a **20 MiB maximum** and **100,000 nonblank data rows maximum**. Individual CSV records are limited to 64 KiB. BOMs, quoted commas, escaped quotes and quoted newlines are supported. Empty, whitespace-only and delimiter-only rows are ignored as blank records. Other malformed records are rejected. Error rows refer to physical line numbers; a multiline record is identified by its ending line. Error responses include the first 200 validation issues.

Amounts must be positive plain decimals with at most two fractional digits. No exponent notation, separators, signs, currency symbols, zero, negative values or excess precision are accepted. BigInt decimal parsing converts to integer cents; the per-record maximum is CAD 100,000,000.00 (10,000,000,000 cents). The maximum of 100,000 such records totals 1,000,000,000,000,000 cents, within the JavaScript safe integer range. Persistence must also bound workspace accumulation or guard aggregate totals. Money calculations use integer cents, and exact decimal formatting uses integer division.

Dates require valid ISO calendar values, including leap-year validation. Due dates cannot precede invoice dates. IDs must be nonempty where required, at most 120 characters and contain no control characters. References are at most 1,000 characters and cannot contain null characters. Currency is normalized to uppercase and only CAD is accepted.

Imports are all-or-nothing: **any validation error produces no importable records**. The domain parser detects duplicates within a file; workspace conflicts, repeated content hashes and reordered duplicates are checked transactionally by persistence. Existing records must never be silently overwritten. CSV exports quote all fields and prefix spreadsheet formula-like cells, including formula-like headers or leading whitespace, with an apostrophe.

Run `npm test` for money, CSV, matching and fixture accounting checks. PostgreSQL integration and measured benchmark instructions belong to the project’s main verification documentation; generator timing alone does not measure database import performance.
