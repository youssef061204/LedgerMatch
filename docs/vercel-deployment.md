# Vercel web app with Render database and worker

Production web URL: https://ledgermatch-eight.vercel.app

The web application runs on Vercel. `render.yaml` provisions PostgreSQL and
the persistent pg-boss worker in Virginia. The worker applies the existing
checksum-tracked migrations before starting and drains jobs during shutdown.
No Redis instance is needed: the queue uses PostgreSQL.

## Provision the backend

Apply the Blueprint from the `main` branch:

https://dashboard.render.com/blueprint/new?repo=https://github.com/youssef061204/LedgerMatch

Review the worker's paid Starter plan before applying (currently $7 USD/month
for [0.5 CPU / 512 MB](https://render.com/articles/render-vs-railway)). The database uses
[Render's free plan](https://render.com/docs/free), which expires after 30 days. Upgrade it before expiry for
a continuing deployment. Provisioning the Blueprint is required; the presence
of this file does not mean these services are running.

## Connect Vercel

After the database is available, store its **external** connection URL as the
Vercel Production `DATABASE_URL` secret, with `sslmode=require`. Render's worker
uses the internal connection string injected by the Blueprint.

The Vercel project also requires:

- `SESSION_PASSWORD`: unique randomly generated secret of at least 32 characters.
- `APP_ORIGIN`: `https://ledgermatch-eight.vercel.app`.
- `COOKIE_SECURE`: `true`.
- `ML_ENABLED`: `true` (the default).
- `ML_MODEL_FILE`: `ranker.json` (the default).

Redeploy after setting environment variables. Never upload `.env` or `.local`;
the checked-in `.vercelignore` excludes both.

## Verify

Confirm Render shows a live worker and `worker_ready` in its logs. Confirm
`/api/health` returns `{"status":"ok"}` on Vercel. Then run the browser suite:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'https://ledgermatch-eight.vercel.app'
npm run test:e2e
```

Check demo creation, sample data, reconciliation, manual allocation and reversal,
CSV export, session isolation, and the `/evaluation` dashboard. [Vercel functions
limit request bodies to 4.5 MB](https://vercel.com/docs/functions/limitations), so the app's local 20 MiB CSV limit does not apply
to the hosted import endpoint; keep hosted uploads below the platform limit.
