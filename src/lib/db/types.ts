export type User = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

export type MediaType = "video" | "image";

export type FileRecord = {
  id: string;
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
  created_at: string;
};
