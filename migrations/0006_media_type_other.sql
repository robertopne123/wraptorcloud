alter table files drop constraint if exists files_media_type_check;
alter table files drop constraint if exists files_kind_check;
alter table files add constraint files_media_type_check check (media_type in ('video', 'image', 'other'));
