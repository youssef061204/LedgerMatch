# ML-assisted payment reconciliation

LedgerMatch's deterministic rules still allocate only compatible, uniquely referenced payments. A learned ranker assists with unresolved exceptions; every ML-assisted allocation requires an authenticated reviewer's explicit selection and note. PostgreSQL constraints, locking, audit evidence, reversal and durable retries remain unchanged.

The project is a production-style engineering demonstration with synthetic experiments. It is not a validated production accounting system. Read the measured [results](benchmark-results.md) and [resume claims](resume-metrics.md), both generated from the experiment artifacts.

## Architecture

`src/domain/matching.ts` implements existing indexed candidate retrieval and heuristic scoring. The default domain API still returns five candidates. With a valid enabled model, the worker requests up to 20 candidates using the same indices and scores. It completes deterministic proposals, computes final outstanding balances, then ranks only review proposals. The first three heuristic results are unchanged by the expanded limit. Shared-pool MRR is explicitly distinguished from the original five-result display.

`src/ml/features.ts` is the only payment/invoice feature implementation. The TypeScript dataset exporter runs it for training; Node inference uses the same function. Python never reimplements payment features. Values are cast to float32 before fitting/scoring; money and accounting operations continue to use integer cents.

`ml/train.py` fits a standardized logistic regression baseline and two XGBoost pair classifiers (120 trees; depths three and five; learning rate 0.08; CPU histogram training; fixed seed; four threads). Selection uses only selection-validation top-1 accuracy. Binary pair classification handles all-negative candidate groups directly, including no valid invoice and retrieval misses. Candidate scores are ordered within each payment group. A separate group-level calibrator estimates top-choice correctness; pair classifier outputs are not presented as calibrated group confidence.

Python exports its native model plus a small validated JSON tree/linear representation. `src/ml/model.ts` executes that representation in Node. Node predictions are checked against native Python validation probes. Tree shapes, feature schemas, versions, numerical values and acyclic child references are validated at load time. No pickle files or Python runtime service are deployed.

The worker caches one model per configured filename for its process lifetime. `ML_ENABLED=false` skips model loading and restores the original heuristic review path. Missing or invalid artifacts emit a structured warning and fall back to heuristics. `ML_MODEL_FILE` selects a filename within `models/`; path traversal and arbitrary paths are rejected. Restart app/worker after replacing a model. The versioned checked-in model lets a clone run the app without training first.

`migrations/003_ml_recommendations.sql` adds nullable review metadata. Suggestions store the model identifier, threshold, confidence, decision and explanation. They never create allocation proposals. Duplicate, reference-ambiguity, mismatch, overpayment, settled, reversed and deferred statuses remain review holds regardless of score. Manual allocation/reversal/defer clears previous recommendation metadata. The payment detail endpoint removes candidates whose balances have been consumed since ranking and abstains when the visible candidate set has become stale. Database constraints always recheck the eventual human allocation.

## Synthetic data and ground truth

`src/ml/dataset.ts` samples a latent intended invoice before corrupting observable fields. The matcher never creates labels. There are 30,000 main groups plus 3,000 robustness groups by default; each group contains one payment and a locally plausible invoice set. Exact clean controls are retained in metadata but excluded from ML exception metrics.

Scenarios cover missing/truncated/mistyped references, prefix/suffix removal, inserted whitespace, punctuation changes, incorrect and misleading references; exact and near amounts, rounding underpayments, larger underpayments, partial payments, overpayments, combined payments, duplicate amounts; missing/wrong customer identifiers and similar identifiers; before/near/after-due timing, close invoice dates and stale invoices; no valid invoice, target outside retrieval, and duplicate-looking invoices. OCR substitutions and transposed digits are withheld for robustness, alongside larger candidate sets. The current schema has customer identifiers, not customer-name fields; similar identifier strings exercise that available signal.

Overpayments, combined payments and customer mismatches have no valid whole-payment allocation under the current accounting contract. They are negatives, not relaxations of accounting constraints. A deliberately omitted retrieval target still has a valid latent invoice and counts as a ranking failure. Duplicate-looking cases may be intrinsically indistinguishable; their latent labels do not imply recoverable evidence.

These simulated distributions encode assumptions about remittance references and payment timing. They do not establish real-world accuracy. The old throughput fixture is a different dataset; its deterministic correctness results must never be labeled ML accuracy.

## Leakage controls

Cases are grouped into cohorts of ten with shared customer identities. Whole cohorts go to train (60%), validation (20%) and test (20%). Validation cohorts are divided again into model-selection, calibration and threshold subsets. Robustness cohorts use disjoint entity identifiers and withheld corruptions. Raw IDs and cohort numbers are not model columns; only payment/invoice relationships and candidate context are features.

`assertSplitIsolation` checks cohort, case, payment, invoice and customer identities across partitions and validation roles, and rejects withheld corruptions in the main partitions. Automated tests deliberately introduce cross-split identity reuse and bad labels. The data manifest stores generator/feature versions, seed, file hashes, feature names, source hashes and counts. Training checks train/validation hashes and never opens test/robustness files. Evaluation verifies the frozen manifest and shared-feature identity, and performs no fitting. The first final evaluation and all subsequent reruns use the same model parameters and thresholds; the weaker robustness result is retained.

## Calibration and metrics

Each method gets a Platt-style logistic calibrator fitted on its top score, first/second score margin, and log candidate count using calibration-validation cohorts. Threshold-validation cohorts select maximum coverage at empirical 99%, 98% and 95% precision with at least 50 accepted groups. Ties are included as complete groups of equal scores. Unsupported targets disable recommendations with threshold 1.01. The default uses the 99% validation target. The original heuristic could not satisfy these precision targets with sufficient support, so its thresholded coverage is zero; this is distinct from always displaying heuristic suggestions.

The report shows observed test precision, not the validation target as if it were a guarantee. It includes Wilson intervals, Brier score, calibration bins and expected calibration error. Calibration under distribution shift can deteriorate; confidence is specific to these synthetic experiments.

Top-1/top-3/MRR divide by **all valid-match exceptions**, including retrieval failures. No-valid-invoice cases are excluded from those ranking denominators and included in recommendation precision/coverage. The report separately counts no-valid-invoice cases, candidate recall, accepted recall, abstention, false recommendations, no-match abstention recall/precision and confusion statistics. Empty denominators are null, not 100%.

The reviewer benchmark is a **system proxy**: inspect up to five displayed suggestions in order, then count one escalation step if the true invoice is missing. Average over all valid-match exceptions. It does not assume actual review times or simulate human accuracy. No human study or labor-savings claim is made.

## Runtime measurement

`scripts/performance.ts` runs the real PostgreSQL import and worker service on the existing seed-42 workload. Three modes compare 100-effect baseline transactions, 1,000-effect optimized transactions and 1,000-effect transactions with ML. Every mode gets a fresh workspace and identical input. Mode order rotates across three trials. The report retains every observation, median/min/max, sampled Node RSS, compute/inference/persistence stages and batch p50/p95/p99.

Profiling preceded the optimization: the pure 1k matcher took milliseconds while the rolled-back allocation insert demonstrated trigger/constraint cost; instrumented runs then showed persistence dominates full runtime. Larger batches reduce batch transaction count tenfold and cut database round trips without weakening constraints, audit writes or retry fencing. Tradeoffs are coarser progress checkpoints, larger retry units and longer individual transactions. Batch p95 values are not individual-payment or HTTP latencies. Queue wait is excluded. The unchanged historical benchmark was independently reproduced before modification; the measured improvement uses the repeated contemporaneous baseline, not the historical fastest or slowest observation.

Existing demo/test evidence is retained, so the database grows across trials and cache/planner conditions vary. Baseline variance is visible. No hardware-isolated throughput claim or statistical significance claim is made. The ML dataset and throughput workload differ; inference p95 on the evaluation dataset is reported separately from total worker runtime.

## Exact reproduction commands

Install Node 24 and Docker with Compose. For training, Python 3.13 was verified. From the repository root:

```powershell
npm ci
# First-time clones: copy .env.example to .env and set SESSION_PASSWORD.
docker compose up -d db
npm run db:migrate
py -3.13 -m venv .local/ml-venv
.local/ml-venv/Scripts/python.exe -m pip install -r ml/requirements.txt
npm run ml:data -- 30000 20260913
npm run ml:train
npm run ml:evaluate
npm run profile
npm run benchmark:compare -- 100000 3
npm run ml:report
npm run ml:verify
npm test
npm run test:integration
npm run lint
npm run typecheck
npm run build
docker compose up --build -d
npx playwright install chromium
npm run test:e2e
```

On macOS/Linux use `python3.13 -m venv .local/ml-venv` and `.local/ml-venv/bin/python -m pip install -r ml/requirements.txt`. The npm training/reproducibility commands detect either virtual environment layout; `ML_PYTHON` can specify another interpreter. Package versions are pinned in `ml/requirements.txt`; Node dependencies use `package-lock.json`.

`npm run ml:verify` regenerates files and retrains into an ignored scratch directory, asserting byte-identical dataset manifests, model parameters, calibration, thresholds and native prediction probes. It also runs Python training/export tests. Timestamps are expected to change; parameters are not. Retraining is offline and model deployment requires rebuilding/restarting the running containers.

Open **http://127.0.0.1:3000/evaluation** for the interactive report and **http://127.0.0.1:3000** for reconciliation. The sidebar links to evaluation. Docker includes the checked-in model and public report, so neither dataset generation nor Python is required for the demo. The app's static JSON download and generated Markdown both come from `artifacts/evaluation/latest.json`; no result cards use placeholder values.

To rerun only the old-style benchmark command with ML disabled in PowerShell:

```powershell
$env:ML_ENABLED = 'false'
npm run benchmark -- 100000
Remove-Item Env:ML_ENABLED
```

That command uses the current default transaction size. For the preserved 100-effect baseline implementation, use `npm run benchmark:compare -- 100000 3`, which explicitly selects the old batch size. Immutable historical and independently reproduced pre-change observations remain under `artifacts/baseline/`.

## Artifacts and limitations

- `models/ranker.json`: deployable versioned model, feature names, preprocessing/calibration configuration, thresholds, selection trials and environment metadata.
- `models/xgboost-native.json`: native Python model for inspection/reuse.
- `models/parity.json`: native validation prediction probes for cross-runtime tests.
- `.local/ml-data/`: ignored generated datasets and manifest; not committed.
- `artifacts/evaluation/ml.json`: frozen model evaluation, error breakdown, precision/coverage, examples, calibration and inference latency.
- `artifacts/performance/latest.json`: all repeated PostgreSQL observations and stage/batch timings.
- `artifacts/evaluation/latest.json`: consolidated source for dashboard and generated resume/benchmark Markdown.
- `artifacts/evaluation/reproducibility.json`: independently repeated data/training verification.

Current limits include synthetic labels, no externally validated financial dataset, no real reviewer trial, no model drift monitoring, no automatic retraining or hot model replacement, bounded retrieval, buffered imports/exports and growing retained demo data. The boosted model is not uniformly better than logistic regression: the withheld-corruption test explicitly exposes that failure. Fraud, late-payment prediction, cash-flow forecasting, FX, payment splitting and bank integrations are not implemented or claimed.

Method references: [XGBoost model export](https://xgboost.readthedocs.io/en/stable/tutorials/saving_model.html), [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html), [data leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html).
