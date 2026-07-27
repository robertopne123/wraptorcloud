-- Stage 5: share links are created with no auth (no current user to set as
-- creator), and need a permission level distinguishing view-only access
-- from view+download access.
alter table share_links alter column created_by drop not null;

alter table share_links add column if not exists permission text not null default 'view'
  check (permission in ('view', 'download'));
