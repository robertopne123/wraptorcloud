create table if not exists migration_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  total integer not null default 0,
  processed integer not null default 0,
  migrated integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,
  current_file text,
  current_folder text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
