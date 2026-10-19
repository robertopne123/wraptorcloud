create table if not exists wr27_gallery_uploads (
  id uuid primary key,
  data jsonb not null,
  resource text,
  created_at timestamptz not null default now(),
  client_hash text not null,
  state text not null check (state in ('preparing','staged','creating','file_created','published','failed')),
  file_id text,
  entry_id text
);
create index if not exists wr27_gallery_uploads_client_time on wr27_gallery_uploads(client_hash, created_at);
create index if not exists wr27_gallery_uploads_time on wr27_gallery_uploads(created_at);
alter table wr27_gallery_uploads enable row level security;
revoke all on wr27_gallery_uploads from anon, authenticated;
