# Wraptor Vault

Internal media asset manager for uploading, organizing, and sharing video/image
footage.

**Stage 2 (this stage):** direct-to-S3 upload pipeline. `/dashboard` is a
drag-and-drop uploader backed by presigned URLs. File browser, media viewer,
and folder UI are still not built. There is no authentication — every route
is open.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase Postgres, queried through a lightweight `postgres` client
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) for
  presigned S3 uploads

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
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `S3_BUCKET_NAME` | Used by `src/lib/s3.ts` to sign upload URLs |
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
straight to `/dashboard`, no login required. Drag files onto the dropzone or
use "Choose files" to upload video/image footage directly to S3.

### 6. S3 bucket CORS

Uploads PUT directly from the browser to S3 using a presigned URL, so the
bucket must allow cross-origin PUT requests from wherever the app is served.
Example bucket CORS configuration:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"]
  }
]
```

## Project structure

```
migrations/              Raw SQL migrations, applied in filename order
scripts/                 migrate.ts / seed.ts (run via tsx)
src/app/api/upload-url/  POST: presigned S3 PUT URL for a new upload
src/app/api/files/       GET: list files, POST: record a completed upload
src/app/dashboard/       Upload UI (page.tsx fetches initial files, upload-dashboard.tsx is the client-side uploader)
src/lib/db/              Postgres client + query functions (client.ts is the query layer; supabase.ts is a stub for later)
src/lib/s3.ts            S3 client, used by /api/upload-url
src/lib/media.ts         Shared video/image content-type validation
```

## How uploads work

1. The client asks `POST /api/upload-url` for a presigned S3 PUT URL, passing
   the filename, content type, and size. The route validates the content type
   (`video/*` or `image/*` only), generates a UUID, and builds the S3 key as
   `footage/<uuid>.<ext>`.
2. The browser PUTs the file straight to S3 using that URL (tracked via
   `XMLHttpRequest` for upload progress — `fetch` has no progress event).
3. On a successful PUT, the client calls `POST /api/files` to insert a row
   into the `files` table (media type derived from content type).
4. Multiple files upload in parallel, each with its own progress bar; a
   failed file gets a Retry button that redoes the same three steps.
5. Passing `?folderId=<uuid>` on `/dashboard` attaches uploads to that folder;
   omitting it leaves `folder_id` null (root). There's no folder UI yet
   (Stage 3).

## Notes

- There is currently no authentication. Every route is open. The `users`
  table stays only to give future uploads an `owner_id` to reference — it's
  nullable and not populated by the upload pipeline.
