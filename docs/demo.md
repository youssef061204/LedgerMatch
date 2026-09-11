# Two-minute demo

Use fictional data only. Start the web app, PostgreSQL and the separate worker before presenting (see the README).

1. **0:00–0:15 — Enter a workspace.** Open `http://127.0.0.1:3000` and select **Try demo**. Each fresh browser session gets its own empty workspace. Point out the explicit synthetic-data label.
2. **0:15–0:30 — Bring records together.** Select **Load sample data**. The fixture includes exact and partial payments, unknown references, overpayments, customer mismatches and duplicate-looking payments. The Imports screen also offers CSV templates, column mapping and row-level validation.
3. **0:30–0:50 — Reconcile.** Select **Run reconciliation**. Watch queued/running/completed progress. Explain that explicit compatible references can allocate automatically; ambiguous suggestions require review. Open an allocated payment to show its explanation.
4. **0:50–1:20 — Resolve an exception.** Open **Exceptions**, search `PAY-1001` and open it. Two Maple invoices are plausible. Select `INV-1001`, enter `Synthetic remittance checked: the intended invoice is INV-1001.`, and select **Allocate payment**. This allocates CAD 1,250.00.
5. **1:20–1:40 — Check the effect.** Close the panel and return to **Overview**: allocated payments increase by CAD 1,250.00 and both outstanding balance and unallocated payments decrease by the same amount. Open **Audit trail** and search `PAY-1001` to show the reviewer and note.
6. **1:40–2:00 — Export and explain.** Open **Reconciliation** and select **Export results**. Explain the two accounting identities: invoice total = allocated + outstanding; payment total = allocated + unallocated.

Optional engineering follow-up: reopen the payment, enter a reason and reverse its allocation. The balance returns and history remains. A later reconciliation does not automatically undo this human decision. Use a separate browser profile/incognito window to demonstrate an independent empty workspace.

If a run stays queued, verify that the worker is running and uses the same `DATABASE_URL` as the app. Refreshing a browser does not consume jobs. **Reset demo data** switches your session to a newly seeded workspace; the previous exercise's historical evidence remains in the database.
