# Cloudflare deployment

The production backend runs as the `filetransfers` Cloudflare Worker. Account/session,
subscription, and hosted-file metadata lives in the `filetransfers` D1 database;
file bytes remain in the existing `filetransfers` R2 bucket. There is no runtime
PostgreSQL or filesystem dependency.

`filetransfersapp.com` serves the website, authentication, tRPC, webhooks, and hosted
share pages. `storage.filetransfersapp.com` remains the existing R2 custom domain.
Uploads and downloads use signed R2 S3 URLs so file bodies bypass the Worker.

## Deployment

Changes to backend/runtime files on `main` deploy through `.github/workflows/cloudflare.yml`.
The GitHub `CLOUDFLARE_API_TOKEN` secret has Worker deployment access. Application
secrets remain in Cloudflare; deploying does not read or publish the developer's
`.env` file. Deployment records `APP_REVISION` as the Git commit SHA.

Manual deployment: `pnpm worker:deploy`. Validate first with `pnpm typecheck`,
`pnpm exec oxlint server drizzle.config.ts worker-configuration.d.ts`, and `pnpm build`.

For local development, copy `.dev.vars.example` to ignored `.dev.vars`,
apply migrations with `pnpm exec wrangler d1 migrations apply DB --local`, then run
`pnpm worker:dev`. Use local D1/R2; do not bind development to production data.

## Database changes

`pnpm db:generate` creates SQLite migrations under `server/db/d1-migrations`.
Apply a reviewed migration with `pnpm exec wrangler d1 migrations apply DB --remote`
using an account credential with D1 write access. Production data migrations are
not automatically run by the deployment workflow. Coordinate schema compatibility
with code rollout. Historical PostgreSQL migrations are retained as migration
history and must not be applied to D1.

## Secrets and compatibility

Preserve `BETTER_AUTH_SECRET` and the production auth URL: existing sessions and
signed share links depend on them. Keep Apple/Google OAuth settings, the RevenueCat
webhook secret, and R2 S3 credentials configured in the Worker. The native R2
binding is used for object metadata and deletion; S3 credentials sign direct
client transfers.

The existing mobile protocol uses a single presigned PUT. Files beyond R2's single
PUT size limit require a future multipart client/server protocol; the migration
canary does not establish multi-gigabyte upload support.
