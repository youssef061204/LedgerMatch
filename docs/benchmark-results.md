# Generated experiment results

Source: `artifacts/evaluation/latest.json`. Regenerate using `npm run ml:report`; do not hand-edit metrics.

## Held-out synthetic ranking

Top-1/top-3/MRR denominator: all valid-match exceptions, including retrieval misses. No-valid-invoice groups assessed separately and included in precision/coverage. Exact deterministic controls excluded.

| Model | Top-1 | Top-3 | MRR | Precision | Coverage |
|---|---:|---:|---:|---:|---:|
| heuristic | 24.13% | 62.95% | 0.469 | N/A | 0.00% |
| logistic | 83.98% | 93.68% | 0.888 | 98.49% | 43.76% |
| xgboost | 87.15% | 94.95% | 0.909 | 98.92% | 68.83% |

Top-1 improvement: 63.02 percentage points; relative error reduction: 83.06%. Model false recommendations: 43; abstentions: 1795; 95% Wilson precision interval: 98.54% to 99.19%.

Withheld OCR/transposition: boosted top-1 76.87%, logistic top-1 92.30%. This limitation is retained; models were not retuned after inspecting the test.

## Reconciliation

Historical unchanged-code run: 60.834 seconds. Independently reproduced unchanged-code run: 55.689 seconds. Both yielded 69,999 correct deterministic allocations.

| Mode | Median seconds | Min / max seconds | Payments/s | Batch p95 ms |
|---|---:|---:|---:|---:|
| baseline | 37.011 | 33.553 / 46.888 | 2702 | 63.93 |
| optimized | 16.826 | 16.594 / 18.428 | 5943 | 229.22 |
| integrated | 17.613 | 17.445 / 18.172 | 5678 | 234.97 |

Local Node process and PostgreSQL Docker on same host. Identical freshly imported seed-42 workloads; queue wait excluded. Modes rotated across trials; no forced cold caches or GC. Existing evidence retained.

p50/p95/p99 are wall-clock persistence transaction batch latencies (100 vs 1000 effects), NOT individual payment/request latency. Total run median/min/max are separate.

RSS sampled every 25ms; Node process only including fixtures and retained allocations; excludes PostgreSQL/Docker; may miss brief peaks.

Warm per-exception feature/inference/explanation p50/p95/p99: 0.103 / 0.233 / 0.376 ms across 5759 cases. Sequential per-exception shared feature computation + model traversal + calibration + explanation; excludes database, candidate retrieval, model loading and HTTP.

## Reviewer proxy

Candidate inspection proxy, not human time. Inspect at most five suggestions; add one escalation step if truth is not visible. Denominator: all valid-match exceptions.

Heuristic 3.110 vs boosted 1.338 steps; 56.98% reduction. No human study was conducted.

See the interactive [/evaluation](http://127.0.0.1:3000/evaluation) page for precision/coverage, calibration, corruption breakdowns and successes/failures. Raw results retain all trials.
