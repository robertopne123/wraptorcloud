import { sql } from "./client";
import type { FileRecord, Folder, MediaType, ShareLink, SharePermission, User } from "./types";

export async function listUsers(): Promise<User[]> {
  return sql<User[]>`select id, email, name, created_at from users order by name`;
}

// --- Folders ---

export async function getFolder(id: string): Promise<Folder | null> {
  const rows = await sql<Folder[]>`select * from folders where id = ${id} limit 1`;
  return rows[0] ?? null;
}

export async function listFolders(parentId: string | null): Promise<Folder[]> {
  return parentId === null
    ? sql<Folder[]>`select * from folders where parent_id is null order by name`
    : sql<Folder[]>`select * from folders where parent_id = ${parentId} order by name`;
}

export async function listAllFolders(): Promise<Folder[]> {
  return sql<Folder[]>`select * from folders order by name`;
}

// Ancestor chain from root to the given folder (inclusive), for breadcrumbs.
export async function getFolderPath(id: string): Promise<Folder[]> {
  const rows = await sql<Folder[]>`
    with recursive path as (
      select * from folders where id = ${id}
      union all
      select f.* from folders f inner join path p on f.id = p.parent_id
    )
    select * from path
  `;
  return rows.reverse();
}

export async function createFolder(input: {
  name: string;
  parentId: string | null;
}): Promise<Folder> {
  const rows = await sql<Folder[]>`
    insert into folders (name, parent_id) values (${input.name}, ${input.parentId})
    returning *
  `;
  return rows[0];
}

export async function renameFolder(id: string, name: string): Promise<Folder | null> {
  const rows = await sql<Folder[]>`
    update folders set name = ${name} where id = ${id} returning *
  `;
  return rows[0] ?? null;
}

export async function moveFolder(id: string, parentId: string | null): Promise<Folder | null> {
  const rows = await sql<Folder[]>`
    update folders set parent_id = ${parentId} where id = ${id} returning *
  `;
  return rows[0] ?? null;
}

// True if candidateId is rootId itself or one of rootId's descendants —
// used to reject moves that would turn a folder into its own ancestor.
export async function isFolderOrDescendant(rootId: string, candidateId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    with recursive descendants as (
      select id from folders where id = ${rootId}
      union all
      select f.id from folders f inner join descendants d on f.parent_id = d.id
    )
    select id from descendants where id = ${candidateId}
  `;
  return rows.length > 0;
}

export async function deleteFolder(id: string): Promise<void> {
  await sql`delete from folders where id = ${id}`;
}

// --- Files ---

export async function getFile(id: string): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    select * from files where id = ${id} and deleted_at is null limit 1
  `;
  return rows[0] ?? null;
}

export async function listFiles(folderId: string | null): Promise<FileRecord[]> {
  return folderId === null
    ? sql<FileRecord[]>`
        select * from files where folder_id is null and deleted_at is null order by created_at desc
      `
    : sql<FileRecord[]>`
        select * from files where folder_id = ${folderId} and deleted_at is null order by created_at desc
      `;
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

export async function renameFile(id: string, displayName: string): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    update files set display_name = ${displayName}
    where id = ${id} and deleted_at is null
    returning *
  `;
  return rows[0] ?? null;
}

export async function moveFile(id: string, folderId: string | null): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    update files set folder_id = ${folderId}
    where id = ${id} and deleted_at is null
    returning *
  `;
  return rows[0] ?? null;
}

export async function listFilesForDownload(input: {
  fileIds: string[];
  folderIds: string[];
}): Promise<FileRecord[]> {
  const results: FileRecord[] = [];

  if (input.fileIds.length > 0) {
    const direct = await sql<FileRecord[]>`
      select * from files where id = any(${input.fileIds}) and deleted_at is null
    `;
    results.push(...direct);
  }

  if (input.folderIds.length > 0) {
    const fromFolders = await sql<FileRecord[]>`
      with recursive tree as (
        select id from folders where id = any(${input.folderIds})
        union all
        select f.id from folders f inner join tree t on f.parent_id = t.id
      )
      select files.* from files
      inner join tree on files.folder_id = tree.id
      where files.deleted_at is null
    `;
    results.push(...fromFolders);
  }

  const seen = new Set<string>();
  return results.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

export async function updateFileThumbnail(
  id: string,
  input: {
    thumbnailKey: string;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
  },
): Promise<void> {
  await sql`
    update files
    set
      thumbnail_key = ${input.thumbnailKey},
      duration_seconds = ${input.durationSeconds},
      width = ${input.width},
      height = ${input.height}
    where id = ${id} and deleted_at is null
  `;
}

export async function softDeleteFile(id: string): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    update files set deleted_at = now()
    where id = ${id} and deleted_at is null
    returning *
  `;
  return rows[0] ?? null;
}

// --- Share links ---

export async function createShareLink(input: {
  token: string;
  fileId: string | null;
  folderId: string | null;
  permission: SharePermission;
  expiresAt: string | null;
}): Promise<ShareLink> {
  const rows = await sql<ShareLink[]>`
    insert into share_links (token, file_id, folder_id, permission, expires_at)
    values (${input.token}, ${input.fileId}, ${input.folderId}, ${input.permission}, ${input.expiresAt})
    returning *
  `;
  return rows[0];
}

export async function listShareLinksForFile(fileId: string): Promise<ShareLink[]> {
  return sql<ShareLink[]>`
    select * from share_links where file_id = ${fileId} order by created_at desc
  `;
}

export async function listShareLinksForFolder(folderId: string): Promise<ShareLink[]> {
  return sql<ShareLink[]>`
    select * from share_links where folder_id = ${folderId} order by created_at desc
  `;
}

// Null for both an unknown token and an expired one, so callers can show a
// single unified "expired or doesn't exist" message either way.
export async function getActiveShareLinkByToken(token: string): Promise<ShareLink | null> {
  const rows = await sql<ShareLink[]>`
    select * from share_links
    where token = ${token} and (expires_at is null or expires_at > now())
    limit 1
  `;
  return rows[0] ?? null;
}

export async function deleteShareLinkByToken(token: string): Promise<ShareLink | null> {
  const rows = await sql<ShareLink[]>`
    delete from share_links where token = ${token} returning *
  `;
  return rows[0] ?? null;
}
