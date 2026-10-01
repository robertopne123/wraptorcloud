export type User = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

export type MediaType = "video" | "image" | "other";

export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  owner_id: string | null;
  created_at: string;
  file_count?: number;
  folder_count?: number;
};

export type FileRecord = {
  id: string;
  version_number: number;
  folder_id: string | null;
  owner_id: string | null;
  display_name: string;
  s3_key: string;
  mime_type: string;
  media_type: MediaType;
  // bigint/numeric columns come back as strings from the pg wire protocol.
  size_bytes: string;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  thumbnail_key: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type FileVersion = Pick<FileRecord,
  "id" | "version_number" | "display_name" | "s3_key" | "mime_type" | "media_type" |
  "size_bytes" | "duration_seconds" | "width" | "height" | "thumbnail_key" | "created_at"
> & { file_id: string; archived_at: string };

export type SharePermission = "view" | "download";

export type ShareLink = {
  id: string;
  token: string;
  file_id: string | null;
  folder_id: string | null;
  created_by: string | null;
  permission: SharePermission;
  expires_at: string | null;
  created_at: string;
};
