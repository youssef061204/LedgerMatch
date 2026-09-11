# Matching rules

`src/domain/matching.ts` implements pure deterministic rule version **1.0.0**. It creates allocation proposals and review suggestions; the persistence layer must enforce workspace authorization, transactions, locks and database constraints when applying them. Matching code has no framework, database or network dependency.

## Automatic allocation

Payments are processed by ascending ISO payment date, then ascending payment ID using JavaScript string comparison. Input array order and machine locale do not affect results. Existing active allocations are retained: callers supply their payment IDs and each invoice's paid amount derived from active allocations.

The following precedence applies to each unallocated payment:

1. Preserve a reviewer’s `reversed` or `deferred` status. A manual decision is required before allocation.
2. Route suspected duplicate payments to review. Compare customer ID, payment date, integer amount, currency and normalized reference across **all** payments, including previously allocated payments. Different IDs do not make otherwise identical business records safe to process. All members of a suspicious group are withheld before any new allocation is proposed.
3. Resolve invoice references. Multiple resolved invoices, including normalized ID collisions, require review. Unknown and missing references receive suggestions only.
4. Require payment and invoice currencies to agree.
5. If a payment provides a customer ID, require exact customer ID equality.
6. Require a positive invoice outstanding balance.
7. Require payment amount to be no greater than the outstanding balance.
8. Allocate the whole payment to that invoice. A smaller amount is a partial allocation. Subsequent payments may settle the remainder.

There is no automatic matching based on amount alone, no payment splitting and no subset-sum search. References identify an intended invoice more conservatively than coincidental amount/date similarity. A reference-free payment with only one candidate still needs human review.

## Reference normalization

Normalize using Unicode NFKC, trim outer whitespace and uppercase. Preserve punctuation inside identifiers: `INV-12`, `INV_12` and `INV12` remain distinct. Resolve the whole normalized reference and complete tokens separated by whitespace, commas, semicolons, colons, parentheses, braces, square brackets, quotes or angle brackets.

For example, `Paid: (inv-12), thank you` resolves to `INV-12`. `INV-123`, `PREFIX-INV-12`, `INV-12/3` and `INV-12+3` do not resolve to `INV-12`. Dots, dashes, underscores, plus signs and slashes stay inside tokens. Some unusual identifiers or prose formats may need manual review; false automatic allocations are the more costly failure. Repeated mentions of the same invoice resolve once. Case or compatibility collisions among invoice IDs produce ambiguity.

## Suggestions and statuses

Candidate scores are heuristic rankings, **not probabilities or calibrated confidence**. Candidates must have compatible currency, compatible supplied customer identity and enough outstanding balance. Score components are:

| Evidence | Points |
| --- | ---: |
| Same supplied customer ID | 50 |
| Amount equals outstanding balance | 30 |
| Amount fits as a partial payment, instead of exact amount | 10 |
| Payment is within 7 days of invoice date | 20 |
| Payment is within 30 days, instead of within 7 days | 10 |
| Reference names the invoice | 40 |

For bounded work, the suggestion search examines up to 48 invoices near the payment date from each relevant customer/amount and customer/date index, plus explicitly referenced invoices. With no customer, only the amount/date index is searched. Up to five candidates are returned, ordered by score then invoice ID. These are suggestions, not an exhaustive search; a reviewer may select another compatible invoice. Candidate compatibility is recomputed against the final proposed balances so a later allocation cannot leave a settled invoice in the suggestions. The amount index reflects balances at run start; customer/date suggestions and manual selection cover balances changed during the run.

Review statuses distinguish `suspected_duplicate`, `ambiguous_reference`, `unknown_reference`, `currency_mismatch`, `customer_mismatch`, `invoice_paid`, `overpayment`, `ambiguous`, `needs_review`, `deferred` and `reversed`. Invoice settlement is independently derived as unpaid, partial or paid from its active allocation total. A payment review status never acts as an invoice settlement status.

## Evidence and reruns

Every automatic allocation includes a readable explanation and structured evidence: rule version, original and normalized reference, resolved invoice ID, customer agreement, currency, payment amount, outstanding balance before and after, and stable processing key. This allows a reviewer to understand the decision without interpreting a score.

The domain function does not mutate caller inputs. With identical inputs it returns identical proposals. To safely rerun, persistence supplies the latest balances and active payment IDs. Duplicate record IDs and invalid integer balances are rejected at the domain boundary. Database enforcement is still essential: concurrent callers could otherwise each compute valid proposals from the same old balance.

Run the executable behavior specifications with `npm test`. They cover reference collisions, precedence, duplicate groups, partial sequences, existing balances, reversal holds, reruns, deterministic ordering and independent synthetic truth.
