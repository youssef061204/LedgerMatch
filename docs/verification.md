# Verification and portfolio handoff

Verified locally on September 11, 2026. No public deployment was provisioned; use the verified local preview at http://127.0.0.1:3000 and the deployment instructions for hosting.

The complete Docker Compose deployment (production app, separate worker, PostgreSQL and migration task) was built and started successfully. All four browser tests passed against those containers in 14.5 seconds. The services are left running.

## Checks

- 96 unit tests: exact money, calendar/CSV validation, source rows, reference collisions, precedence, deterministic order, partials/overpayments, duplicate suspicion and independent fixture truth.
- 14 PostgreSQL integration tests: idempotent/conflicting imports, workspace/viewer denial, concurrency, rollback on failed audit insert, allocation constraints, reversal/defer, overlapping runs, terminal-failure fencing, and an actual pg-boss retry after committed effects.
- 4 Chromium browser tests: demo/queue/review/totals/audit/export/isolation; invalid/corrected mapped CSV; mobile navigation/empty states; reversal/no-rematch/reset and foreign-origin denial.
- ESLint, TypeScript and production build pass. npm audit reports zero vulnerabilities after updating CSV parsing and removing an unused development migration generator.
- Desktop (1280px) and mobile (390px) screenshots inspected, including empty, validation and resolved-payment views. Screenshots regenerate in test-results; they are not a claim of exhaustive accessibility testing.

## PostgreSQL benchmarks

Run `npm run benchmark -- 1000 10000 100000`. Raw results: [benchmark-results.json](../artifacts/benchmark-results.json). Each row below is the final recorded observation for that size, not a statistical estimate. Imports include both CSVs, parsing, row evidence, records and commit; reconciliation invokes the actual worker handler and includes database effects, excluding queue wait. Fixture generation is excluded.

| Invoices | Payments | Import seconds | Import rows/s | Reconcile seconds | Payments/s | Auto allocations | Review cases | Peak RSS MiB import / reconcile |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,000 | 0.140 | 14,251 | 0.290 | 3,444 | 699 | 301 | 142 / 136 |
| 10,000 | 10,000 | 0.947 | 21,118 | 3.040 | 3,289 | 6,999 | 3,001 | 221 / 265 |
| 100,000 | 100,000 | 9.512 | 21,026 | 60.834 | 1,644 | 69,999 | 30,001 | 482 / 518 |

Setup: Intel Core i7-14700HX, 28 logical CPUs, 16 GiB host RAM, Windows 11 (10.0.26200), Node 24.13.0; PostgreSQL 17.11 in Docker on the same host. Rule version 1.0.0, synthetic seed 42. Other local application processes were present; caches were not forced cold. Host CPU/RAM are not dedicated database allocations.

For all three fixtures, automatic-match precision and eligible recall were 100% against independently authored ground truth (699, 6,999 and 69,999 eligible pairs). Precision = correct automatic pairs / all automatic pairs. Eligible recall = correct automatic pairs / unambiguous, automation-eligible truth pairs. Intentionally ambiguous, duplicate, mismatch and overpayment cases are excluded from that recall denominator and correctly routed to review. This measures correctness on these synthetic fixtures, not real-world accuracy or calibrated confidence. All measured accounting identities passed.

RSS is sampled every 25ms from the benchmark Node process. It includes fixtures, strings and retained runtime allocations; excludes PostgreSQL/Docker; can miss short peaks; does not force garbage collection. No latency percentiles, business impact or performance-improvement claims are made.

## Bottleneck investigation

`npx tsx --env-file=.env scripts/profile.ts` records [EXPLAIN evidence](../artifacts/bottleneck-investigation.txt). Pure matching of 1,000 invoices/payments took 8.08 ms. A rolled-back 100-allocation insert took 17.339 ms in PostgreSQL, including 9.256 ms in the allocation guard plus foreign-key checks. This supports investigating persistence/constraint work before optimizing the pure matcher; it does not isolate every cost in the full pipeline. The probe omits audit/progress writes and is not a before/after comparison. Constraints were retained for correctness.

## Limits and next work

No public deployment, invitation/identity-recovery UI, automatic retention cleanup or archive browsing. Whole-workspace matching and buffered exports consume memory; imports/tables are bounded, but a streaming import/export path and worker memory limits would be useful next. Same-workspace writes intentionally wait during reconciliation. Candidate search is bounded; invoice search supports manual alternatives. SQL migrations are authoritative; Drizzle currently types membership queries rather than the complete financial repository. No real-bank or production-accounting claims.

## Proposed resume bullets

- Built a full-stack transaction reconciliation application with Next.js, TypeScript and PostgreSQL, including validated CSV imports, explainable matching, exception review and reversible audited allocations.
- Protected financial effects with database constraints, workspace authorization, serialized transactions and durable job retries; verified behavior with 96 unit, 14 PostgreSQL integration and 4 browser tests.
- Benchmarked 100,000 synthetic invoices and 100,000 payments: 9.51-second imports and 60.83-second reconciliation, with 69,999 correct automatic allocations against independently specified fixture truth.
