-- Stage 2: uploads happen with no auth, so there's no current user to set
-- as owner; make owner_id optional. Also clarify the two file-identity
-- columns the upload API works with.

alter table folders alter column owner_id drop not null;
alter table files alter column owner_id drop not null;

alter table files rename column kind to media_type;
alter table files rename column filename to display_name;
