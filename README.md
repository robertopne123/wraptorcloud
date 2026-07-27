# Wraptor Vault

Internal media asset manager for uploading, organizing, and sharing video/image
footage.

**Stage 1 (this stage):** project setup and database schema. Upload, file
browser, media viewer UI, and authentication are not built yet — `/dashboard`
is a placeholder, open to anyone.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase Postgres, queried through a lightweight `postgres` client
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), scaffolded
  now for uploads in Stage 2

## Setup

### 1. Environment variables

Copy the example file and fill in real values:

```bash
cp .env.local.example .env.local
```

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Direct Postgres connection string. This is what the app, migrations, and seed script all query through (`src/lib/db/client.ts`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Reserved for Supabase-specific features (Storage, Realtime) in a later stage — `src/lib/db/supabase.ts` is a ready client, not yet used for queries |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `S3_BUCKET_NAME` | Not used until Stage 2, but required for the S3 client to construct without error |
| `SEED_USER_1_*` / `SEED_USER_2_*` | Name/email for the two seeded user rows (consumed only by `npm run db:seed`) |

### 2. Install dependencies

```bash
npm install
```

### 3. Run the database migration

Applies everything in `migrations/` (in order) against `DATABASE_URL`:

```bash
npm run db:migrate
```

This creates the `users`, `folders`, `files`, `share_links`, and `transcripts`
tables (the last with a pgvector `embedding` column for future transcript
search), plus the `pgcrypto` and `vector` Postgres extensions.

### 4. Seed the two user rows

```bash
npm run db:seed
```

Upserts a row per `SEED_USER_*_EMAIL` into `users`, by email. These rows exist
so future `uploaded_by` foreign keys have someone to point at — there is no
login, so no password is stored.

### 5. Start the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) — you're redirected
straight to `/dashboard`, no login required.

## Project structure

```
migrations/            Raw SQL migrations, applied in filename order
scripts/                migrate.ts / seed.ts (run via tsx)
src/app/api/            API routes (empty for now, populated starting Stage 2)
src/app/dashboard/       Placeholder dashboard (Stage 3 will replace this)
src/lib/db/             Postgres client + query functions (client.ts is the query layer; supabase.ts is a stub for later)
src/lib/s3.ts           S3 client stub, wired up for Stage 2
```

## Notes

- There is currently no authentication. Every route is open. The `users`
  table stays only to give future uploads an `uploaded_by` to reference.
