-- Wraptor Vault initial schema
-- users, folders, files, share_links, transcripts (with pgvector embeddings)

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references folders (id) on delete cascade,
  owner_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists folders_parent_id_idx on folders (parent_id);
create index if not exists folders_owner_id_idx on folders (owner_id);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references folders (id) on delete cascade,
  owner_id uuid not null references users (id) on delete cascade,
  filename text not null,
  s3_key text not null unique,
  mime_type text not null,
  kind text not null check (kind in ('video', 'image')),
  size_bytes bigint not null,
  duration_seconds numeric,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create index if not exists files_folder_id_idx on files (folder_id);
create index if not exists files_owner_id_idx on files (owner_id);

create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  file_id uuid references files (id) on delete cascade,
  folder_id uuid references folders (id) on delete cascade,
  created_by uuid not null references users (id) on delete cascade,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint share_links_target_check check (
    (file_id is not null and folder_id is null) or
    (file_id is null and folder_id is not null)
  )
);

create index if not exists share_links_token_idx on share_links (token);

create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files (id) on delete cascade,
  content text not null,
  -- OpenAI text-embedding-3-small dimension; adjust if a different model is used later.
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists transcripts_file_id_idx on transcripts (file_id);
