alter table files add column if not exists version_number integer not null default 1;

create table if not exists file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  version_number integer not null,
  display_name text not null,
  s3_key text not null,
  mime_type text not null,
  media_type text not null check (media_type in ('video', 'image', 'other')),
  size_bytes bigint not null,
  duration_seconds numeric,
  width integer,
  height integer,
  thumbnail_key text,
  created_at timestamptz not null,
  archived_at timestamptz not null default now(),
  unique (file_id, version_number)
);

-- Receipts keep replayed upload requests idempotent even after another
-- upload has changed the current file's S3 key.
create table if not exists upload_receipts (
  s3_key text primary key,
  file_id uuid not null references files(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists files_active_name_idx
  on files (folder_id, lower(display_name)) where deleted_at is null;
