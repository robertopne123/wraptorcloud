create table if not exists file_notes (
  file_id uuid primary key references files(id) on delete cascade,
  notes text not null default '' check (char_length(notes) <= 10000),
  updated_at timestamptz not null default now()
);
