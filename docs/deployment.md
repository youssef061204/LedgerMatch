# Local preview and deployment

The supported local preview is `http://127.0.0.1:3000`. A hosted deployment requires three running components: the web application, a persistent Node.js worker, and PostgreSQL. A serverless request handler cannot replace the worker. This repository does not imply that a public URL has been deployed; check the handoff/verification results for what was actually run.

## Reproducible local containers

Install Docker with Compose. Copy `.env.example` to `.env`, set a unique `SESSION_PASSWORD` of at least 32 characters, and retain the local origin/cookie settings. Generate a secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 migrate app worker
```

Compose starts PostgreSQL, applies checksum-tracked SQL migrations, then starts the built app and worker. PostgreSQL data persists in the `ledger-data` volume. The local database binds to `127.0.0.1:54329`; the app binds to `127.0.0.1:3000`. `docker compose down` stops the services without removing that volume. Do not add `--volumes` unless discarding all local data is intentional.

To use host Node.js instead, start only the database with `docker compose up -d db`, then follow README install/migrate/build/start instructions and run `npm run worker` in a second terminal. Web and worker processes must use the same `.env` database URL. Browser tests expect the web app and worker to already be running.

## Hosting checklist

1. Choose hosting that supports a web container, an always-running worker container and PostgreSQL. No paid resources are provisioned by these instructions.
2. Build the repository Docker image. Set the web command to `npm start` and the worker command to `npx tsx src/worker.ts`.
3. Configure `DATABASE_URL` for the hosted PostgreSQL connection. Use the provider's documented TLS configuration and trusted certificates. Set a unique strong `SESSION_PASSWORD`, `APP_ORIGIN=https://your-domain.example` and `COOKIE_SECURE=true` on web and worker. Keep secrets in the hosting secret store.
4. Run `npx tsx scripts/migrate.ts` as a release task before starting the new app/worker version. Migrations use an advisory lock and stored checksums; applied migration files must not be edited.
5. Expose only the web port behind HTTPS. Keep PostgreSQL private. Scale workers only after validating queue locking and database capacity; begin with one worker for this demo.
6. Check application/worker logs, then use an incognito browser to enter the demo, load data, run reconciliation, resolve `PAY-1001`, inspect audit history and download CSV. Confirm a second fresh browser context gets an independent empty workspace. A successful image build alone is not deployment verification.
7. Run the browser suite against the public app by setting `PLAYWRIGHT_BASE_URL` to its HTTPS origin. Record the verified URL and date in the handoff only after the workflow passes there.

## Operational limits

Use synthetic records only. The default Compose database credentials are for loopback-only local development. The demo has no invitation UI or identity recovery. Session expiry prevents access but is not an automatic data-retention policy: plan periodic expiration cleanup before opening a long-lived public demo. Use a disposable database for integration/benchmark runs; the tests intentionally preserve immutable evidence. Set hosting resource and database-connection limits, backups and access controls appropriate to the intended demo lifetime. CSV exports are bounded by application limits; this is not a streaming accounting archive.

Monitor queue failures and logs when a run is slow or remains queued. The worker must stay running; restarting only the website does not process pending jobs. Queue recovery may repeat work after interruption and must not be described as exactly-once delivery.
