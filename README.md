# Wraptor Vault

Internal media asset manager for uploading, organizing, and sharing video/image
footage.

**Stage 3 (this stage):** file browser UI — folder navigation, a file grid,
and organize actions (create/rename/move/delete folders and files). Media
playback is still not built; clicking a file thumbnail shows a "preview
coming soon" notice (Stage 4). There is no authentication — every route is
open.

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
search), plus the `pgcrypto` and `vector` Postgres extensions. `migrate.ts`
just applies every file in `migrations/` in order with no tracking of what
already ran — fine for a one-time setup against a fresh database, but don't
re-run it against a database that already has later migrations applied
(non-idempotent statements like `RENAME COLUMN` will fail the second time).

### 4. Seed the two user rows

```bash
npm run db:seed
```

Upserts a row per `SEED_USER_*_EMAIL` into `users`, by email. These rows exist
so future `owner_id` foreign keys have someone to point at — there is no
login, so no password is stored.

### 5. Start the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) — you're redirected
straight to `/vault`, no login required.

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
migrations/                Raw SQL migrations, applied in filename order
scripts/                   migrate.ts / seed.ts (run via tsx)
src/app/api/upload-url/    POST: presigned S3 PUT URL for a new upload
src/app/api/files/         GET ?folderId=: list files in a folder; POST: record a completed upload
src/app/api/files/[id]/    PATCH: rename (displayName) or move (folderId); DELETE: soft delete
src/app/api/folders/       GET ?parentId=: list folders + files at that level; POST: create
src/app/api/folders/[id]/  PATCH: rename (name) or move (parentId); DELETE: cascade delete
src/app/api/folders/tree/  GET: every folder flat, for the move-picker
src/app/vault/             File browser UI — page.tsx (root) and [folderId]/page.tsx fetch
                            server-side, vault-browser.tsx is the client-side grid/breadcrumb/
                            actions, uploader.tsx is the upload widget, item-card.tsx/item-menu.tsx/
                            modals.tsx are the tile and dialog building blocks
src/lib/db/                Postgres client + query functions (client.ts is the query layer; supabase.ts is a stub for later)
src/lib/s3.ts              S3 client, used by /api/upload-url
src/lib/media.ts           Shared video/image content-type validation
```

## How the file browser works

- `/vault` is the root folder; `/vault/[folderId]` is a nested folder — the
  URL is the source of truth for what's open, so folders are linkable and
  bookmarkable. Navigating remounts the browser (via a `key` on the client
  component) so its state doesn't leak between folders.
- The grid lists folders first (alphabetical), then files (newest first).
  Each tile has a checkbox for multi-select and a "…" menu (Rename / Move /
  Delete). Selecting any items shows a bulk Move/Delete bar.
- **Move** opens a modal listing every folder as an indented tree; picking one
  PATCHes `parentId`/`folderId` for every selected item. A folder can't be
  moved into itself or one of its own subfolders — the API checks this via a
  recursive-CTE ancestry query and rejects the cycle with a 400.
- **Delete** always confirms first. Folder delete is a real cascading DELETE
  (existing `ON DELETE CASCADE` removes subfolders and files). File delete is
  a soft delete (`deleted_at` set; S3 object untouched) — deleted files just
  drop out of every listing query.
- Clicking a file thumbnail shows a "Preview coming soon" toast — no
  playback yet (Stage 4).
- The uploader from Stage 2 is embedded on the page and targets whatever
  folder is currently open; newly uploaded files are prepended to the grid
  immediately, no reload needed.

## Notes

- There is currently no authentication. Every route is open. The `users`
  table stays only to give future uploads an `owner_id` to reference — it's
  nullable and not populated anywhere yet.
