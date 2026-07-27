# Wraptor Vault

Internal media asset manager for uploading, organizing, and sharing video/image
footage.

**Stage 5 (this stage):** share links — generate a public link to a file or
folder (view-only or view+download, with an optional expiry) that works with
no auth at `/share/[token]`, for sending footage to people who don't have app
access. Thumbnails are still icons, not real previews (Stage 6). The main app
itself still has no authentication — every route is open.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase Postgres, queried through a lightweight `postgres` client
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) for
  presigned S3 uploads and downloads
- `yet-another-react-lightbox` (+ its zoom/captions/download/video plugins)
  for the media viewer modal

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
src/app/api/files/[id]/view-url/  GET ?disposition=attachment: fresh presigned S3 GET URL
src/app/api/folders/       GET ?parentId=: list folders + files at that level; POST: create
src/app/api/folders/[id]/  PATCH: rename (name) or move (parentId); DELETE: cascade delete
src/app/api/folders/tree/  GET: every folder flat, for the move-picker
src/app/api/share-links/   GET ?fileId=/?folderId=: list existing links for an item; POST: create
src/app/api/share-links/[token]/               GET ?folderId=: public lookup (+ subfolder browsing); DELETE: revoke
src/app/api/share-links/[token]/files/[fileId]/view-url/  GET: share-scoped, permission-checked presigned URL
src/app/vault/             File browser UI — page.tsx (root) and [folderId]/page.tsx fetch
                            server-side, vault-browser.tsx is the client-side grid/breadcrumb/
                            actions, uploader.tsx is the upload widget, viewer.tsx is the media
                            viewer modal, share-modal.tsx is the Share dialog, item-card.tsx/
                            item-menu.tsx/modals.tsx are the tile and dialog building blocks
src/app/share/[token]/     Public share page — page.tsx resolves the token server-side,
                            share-view.tsx dispatches to either the viewer (file share) or
                            public-folder-browser.tsx (folder share, read-only)
src/lib/db/                Postgres client + query functions (client.ts is the query layer; supabase.ts is a stub for later)
src/lib/share.ts           resolveShare() — the token/expiry/containment logic shared by the
                            share-links API route and the server-rendered /share page
src/lib/s3.ts              S3 client + presignFileViewUrl(), used by both view-url routes
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
- Clicking a file thumbnail opens the media viewer (below) instead of just a
  placeholder.
- The uploader from Stage 2 is embedded on the page and targets whatever
  folder is currently open; newly uploaded files are prepended to the grid
  immediately, no reload needed.

## How the media viewer works

- Clicking a file tile opens a full-screen `yet-another-react-lightbox`
  modal seeded with every file in the current folder, so next/prev
  (on-screen arrows, keyboard ←/→) moves between siblings without closing it.
  Escape, the close button, and clicking the backdrop all close it.
- Each file's playback URL is fetched lazily from
  `GET /api/files/:id/view-url` only when it becomes the active slide (not
  eagerly for the whole folder) — a spinner shows until that resolves. The
  route always signs a fresh 1-hour presigned S3 GET URL; nothing is cached
  or persisted.
- Images render through the Zoom plugin's own image component (pinch/scroll
  zoom, pan) — our code only supplies a loading placeholder, never a custom
  image renderer, so that plugin's zoom/pan logic applies unmodified. Videos
  render through the Video plugin as a native `<video controls autoPlay=false>`
  with no poster yet (Stage 6 adds real thumbnails).
- **Download** re-fetches `view-url` with `?disposition=attachment`, which
  sets `ResponseContentDisposition` on the presigned request so S3 itself
  forces a download — this is why it's a separate fetch rather than reusing
  the inline-playback URL, whose signature doesn't include that header.
- Video streams via ordinary HTTP range requests against the S3 URL — no
  special handling needed, since S3 serves `Accept-Ranges: bytes` /
  `206 Partial Content` by default and the browser's native `<video>` element
  already knows how to seek against that.

## How share links work

- The "Share" action (in every item's "…" menu) opens a modal listing any
  existing links for that file/folder first, each with its own Revoke
  button, before offering to generate a new one (permission: View only /
  View + Download; expiry: Never / 24 hours / 7 days / 30 days).
- A share link's token is a `crypto.randomUUID()`, unrelated to the file's
  or folder's own id. `GET /api/share-links/:token` (and the public page
  that calls it server-side) returns the exact same "expired or doesn't
  exist" 404 for both an unknown token and an expired one — never
  distinguishing the two, so there's nothing to learn from probing tokens.
- **Folder shares are recursive**: browsing a shared folder's subfolders is
  allowed, but only within that folder's own subtree. Every request —
  browsing a subfolder (`?folderId=`) or fetching a file's presigned URL —
  is re-validated server-side against the share's root folder via the same
  recursive-CTE ancestry check the private Move modal uses; nothing is
  reachable through a share token beyond what was actually shared, no
  matter what id a client sends.
- **Permission is enforced twice, but only one of those times matters.**
  The UI hides the Download button for a view-only share, but the actual
  gate is server-side: `GET /api/share-links/:token/files/:fileId/view-url`
  rejects `?disposition=attachment` with a 403 whenever the share's
  `permission` isn't `'download'`, regardless of what the frontend does.
- The public `/share/[token]` page reuses the exact same `MediaViewer` from
  the private app (`getViewUrl`/`getDownloadUrl`/`allowDownload` props point
  it at the share-scoped routes instead of `/api/files/:id/...`) and a
  separate read-only grid component for folder shares — no create/rename/
  move/delete actions, just breadcrumb navigation and click-to-view.

## Notes

- There is currently no authentication. Every route is open. The `users`
  table stays only to give future uploads an `owner_id` to reference — it's
  nullable and not populated anywhere yet. Share links have the same
  no-auth `created_by` — anyone with app access can share anything.
