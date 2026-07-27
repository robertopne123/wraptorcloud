import { sql } from "./client";
import type { FileRecord, MediaType, User } from "./types";

export async function listUsers(): Promise<User[]> {
  return sql<User[]>`select id, email, name, created_at from users order by name`;
}

export async function listFiles(): Promise<FileRecord[]> {
  return sql<FileRecord[]>`select * from files order by created_at desc`;
}

export async function createFile(input: {
  s3Key: string;
  displayName: string;
  mimeType: string;
  mediaType: MediaType;
  sizeBytes: number;
  folderId: string | null;
}): Promise<FileRecord> {
  const rows = await sql<FileRecord[]>`
    insert into files (folder_id, display_name, s3_key, mime_type, media_type, size_bytes)
    values (
      ${input.folderId},
      ${input.displayName},
      ${input.s3Key},
      ${input.mimeType},
      ${input.mediaType},
      ${input.sizeBytes}
    )
    returning *
  `;

  return rows[0];
}
