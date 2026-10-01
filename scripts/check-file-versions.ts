import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

// Live database check in an isolated temporary folder. No S3 objects are written.
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
async function main() {
  const q = await import("../src/lib/db/queries");
  const { sql } = await import("../src/lib/db/client");
  const folder = await q.createFolder({ name: `[Temporary version check] ${randomUUID()}`, parentId: null });
  const prefix = `connection-check/${randomUUID()}`;
  const base = { displayName: "clip.mp4", mimeType: "video/mp4", mediaType: "video" as const, sizeBytes: 10, folderId: folder.id };
  try {
    const first = await q.createFile({ ...base, s3Key: `${prefix}/v1` });
    await assert.rejects(q.createFile({ ...base, s3Key: `${prefix}/duplicate` }), q.FileConflictError);
    const second = await q.createFile({ ...base, s3Key: `${prefix}/v2`, conflictAction: "version", targetFileId: first.id, expectedS3Key: first.s3_key });
    assert.equal(second.id, first.id); assert.equal(second.version_number, 2);
    assert.equal((await q.listFileVersions(first.id))[0].s3_key, first.s3_key);
    const replay = await q.createFile({ ...base, s3Key: `${prefix}/v2`, conflictAction: "version", targetFileId: first.id, expectedS3Key: first.s3_key });
    assert.equal(replay.version_number, 2); assert.equal((await q.listFileVersions(first.id)).length, 1);
    const replacement = await q.createFile({ ...base, s3Key: `${prefix}/replacement`, conflictAction: "replace", targetFileId: first.id, expectedS3Key: second.s3_key });
    assert.equal(replacement.id, first.id); assert.equal(replacement.version_number, 2);
    assert.equal((await q.listFileVersions(first.id)).length, 1);
    assert.equal((await q.createFile({ ...base, s3Key: `${prefix}/v2` })).s3_key, replacement.s3_key);
    assert.equal((await q.listFiles(folder.id)).length, 1);
    await q.updateFileThumbnail(first.id, { s3Key: first.s3_key, thumbnailKey: "check-old.jpg", durationSeconds: 1, width: 100, height: 100 });
    assert.equal((await q.getFile(first.id))!.thumbnail_key, null);
    assert.equal((await q.listFileVersions(first.id))[0].thumbnail_key, "check-old.jpg");
    console.log("Version history, replacement, replay and thumbnail isolation passed.");
  } finally {
    await q.deleteFolder(folder.id); await sql.end({ timeout: 2 });
    console.log("Temporary database records removed; no S3 objects created.");
  }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
