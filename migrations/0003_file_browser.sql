-- Stage 3: file browser needs soft-deletable files. Folders keep hard
-- delete (existing ON DELETE CASCADE already handles removing their
-- contents when a folder is deleted).
alter table files add column if not exists deleted_at timestamptz;
