import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import dotenv from "dotenv";
import { google } from "googleapis";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mediaTypeFromContentType } from "../src/lib/media.js";

const LARGE_FILE_WARN_BYTES = 10 * 1024 ** 3; // 10 GB
const LARGE_FILE_TEMP_BYTES = 500 * 1024 * 1024; // 500 MB — above this, download to disk first

dotenv.config({ path: ".env.local" });

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): { folderId: string; rescan: boolean } {
  const arg = process.argv.find((a) => a.startsWith("--folder-id="));
  if (!arg) {
    console.error("Usage: npx tsx scripts/migrate-from-drive.ts --folder-id=<drive-folder-id> [--rescan]");
    process.exit(1);
  }
  return {
    folderId: arg.slice("--folder-id=".length),
    rescan: process.argv.includes("--rescan"),
  };
}

// ── Env validation ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, label = ""): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      const delay = 2000 * 2 ** (i - 1); // 2s, 4s
      console.warn(`  Retry ${i}/${attempts - 1} for "${label}" in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function pool<T>(items: T[], concurrency: number, fn: (item: T, workerIndex: number) => Promise<void>) {
  const queue = [...items];
  async function worker(workerIndex: number) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item, workerIndex);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
}

// ── Google Drive helpers ──────────────────────────────────────────────────────

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
};

async function listDriveChildren(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
): Promise<DriveFile[]> {
  const items: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(
      () =>
        drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType, size)",
          pageSize: 1000,
          pageToken,
        }),
      3,
      `list ${folderId}`,
    );
    for (const f of res.data.files ?? []) {
      items.push({
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType!,
        size: f.size ?? undefined,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

async function getDriveStream(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
): Promise<Readable> {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );
  return res.data as Readable;
}

// ── DB helpers (inline, no shared singleton) ──────────────────────────────────

type Row = Record<string, unknown>;

// ── Migration run progress tracking ──────────────────────────────────────────

type ProgressState = {
  runId: string;
  total: number;
  processed: number;
  migrated: number;
  skipped: number;
  failed: number;
};

async function createMigrationRun(sql: ReturnType<typeof makeDb>, total: number): Promise<string> {
  const rows = await sql<Row[]>`
    insert into migration_runs (total) values (${total}) returning id
  `;
  return rows[0].id as string;
}

async function updateMigrationProgress(
  sql: ReturnType<typeof makeDb>,
  state: ProgressState,
  currentFile: string,
  currentFolder: string | null,
): Promise<void> {
  await sql`
    update migration_runs set
      total        = ${state.total},
      processed    = ${state.processed},
      migrated     = ${state.migrated},
      skipped      = ${state.skipped},
      failed       = ${state.failed},
      current_file   = ${currentFile},
      current_folder = ${currentFolder},
      updated_at   = now()
    where id = ${state.runId}
  `;
}

async function finishMigrationRun(
  sql: ReturnType<typeof makeDb>,
  runId: string,
  status: "done" | "error",
): Promise<void> {
  await sql`
    update migration_runs set status = ${status}, current_file = null,
      current_folder = null, workers = '[]', finished_at = now(), updated_at = now()
    where id = ${runId}
  `;
}

type WorkerSlot = { file: string; folder: string | null; pct: number } | null;

// Writes all worker slots to DB on a fixed interval — one write per tick
// regardless of how many workers are active, avoiding connection contention.
function makeWorkerFlusher(sql: ReturnType<typeof makeDb>, runId: string, slots: WorkerSlot[]) {
  let dirty = false;

  const interval = setInterval(async () => {
    if (!dirty) return;
    dirty = false;
    try {
      const workers = sql.json(slots.filter(Boolean));
      await sql`update migration_runs set workers = ${workers}, updated_at = now() where id = ${runId}`;
    } catch { /* non-fatal */ }
  }, 500);

  return {
    mark() { dirty = true; },
    async flushNow() {
      dirty = false;
      const workers = sql.json(slots.filter(Boolean));
      await sql`update migration_runs set workers = ${workers}, updated_at = now() where id = ${runId}`;
    },
    stop() { clearInterval(interval); },
  };
}

function makeDb(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 3,
    idle_timeout: 0,     // never drop idle connections
    keep_alive: 30,      // TCP keepalive every 30s to survive long tree walks
    connect_timeout: 30,
  });
}

async function findFolder(
  sql: ReturnType<typeof makeDb>,
  name: string,
  parentId: string | null,
): Promise<string | null> {
  const rows = parentId
    ? await sql<Row[]>`select id from folders where name = ${name} and parent_id = ${parentId} limit 1`
    : await sql<Row[]>`select id from folders where name = ${name} and parent_id is null limit 1`;
  return rows[0]?.id as string ?? null;
}

async function upsertFolder(
  sql: ReturnType<typeof makeDb>,
  name: string,
  parentId: string | null,
): Promise<string> {
  const existing = await findFolder(sql, name, parentId);
  if (existing) return existing;
  const rows = await sql<Row[]>`
    insert into folders (name, parent_id) values (${name}, ${parentId}) returning id
  `;
  return rows[0].id as string;
}

async function fileExistsInFolder(
  sql: ReturnType<typeof makeDb>,
  displayName: string,
  folderId: string | null,
): Promise<boolean> {
  const rows = folderId
    ? await sql<Row[]>`
        select id from files
        where display_name = ${displayName} and folder_id = ${folderId} and deleted_at is null
        limit 1
      `
    : await sql<Row[]>`
        select id from files
        where display_name = ${displayName} and folder_id is null and deleted_at is null
        limit 1
      `;
  return rows.length > 0;
}

async function insertFile(
  sql: ReturnType<typeof makeDb>,
  input: {
    s3Key: string;
    displayName: string;
    mimeType: string;
    mediaType: "video" | "image" | "other";
    sizeBytes: number;
    folderId: string | null;
  },
): Promise<string> {
  const rows = await sql<Row[]>`
    insert into files (folder_id, display_name, s3_key, mime_type, media_type, size_bytes)
    values (${input.folderId}, ${input.displayName}, ${input.s3Key}, ${input.mimeType}, ${input.mediaType}, ${input.sizeBytes})
    returning id
  `;
  return rows[0].id as string;
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

function makeS3(region: string, accessKeyId: string, secretAccessKey: string) {
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

// Streaming multipart upload — handles files of any size without buffering.
async function streamToS3(
  s3: S3Client,
  bucket: string,
  key: string,
  stream: Readable,
  contentType: string,
  onProgress?: (pct: number) => void,
  contentLength?: number,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
      ...(contentLength ? { ContentLength: contentLength } : {}),
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024, // 8 MB parts — small enough to get progress on most files
  });
  if (onProgress) {
    upload.on("httpUploadProgress", ({ loaded, total }) => {
      if (loaded && total) onProgress(Math.round((loaded / total) * 100));
    });
  }
  await upload.done();
}

// Buffer upload for small files (thumbnails only).
async function uploadBufferToS3(
  s3: S3Client,
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await withRetry(
    () => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType })),
    3,
    `upload ${key}`,
  );
}

async function presignS3Url(s3: S3Client, bucket: string, key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 3600,
  });
}

// ── Thumbnail generation (reuses existing lib logic inline) ───────────────────

async function runThumbnail(
  fileId: string,
  s3Key: string,
  mediaType: "video" | "image" | "other",
  s3: S3Client,
  bucket: string,
  sql: ReturnType<typeof makeDb>,
) {
  if (mediaType === "other") return;

  try {
    const { generateVideoThumbnail, generateImageThumbnail } = await import(
      "../src/lib/thumbnails.js"
    );
    const thumbnailKey = `thumbnails/${fileId}.jpg`;

    if (mediaType === "video") {
      const sourceUrl = await presignS3Url(s3, bucket, s3Key);
      const { thumbnailBuffer, durationSeconds, width, height } =
        await generateVideoThumbnail(sourceUrl);
      await uploadBufferToS3(s3, bucket, thumbnailKey, thumbnailBuffer, "image/jpeg");
      await sql`
        update files set thumbnail_key = ${thumbnailKey}, duration_seconds = ${durationSeconds},
          width = ${width}, height = ${height}
        where id = ${fileId}
      `;
    } else {
      // image
      const sourceBuffer = await withRetry(
        async () => {
          const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
          const chunks: Buffer[] = [];
          for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
          return Buffer.concat(chunks);
        },
        3,
        `fetch ${s3Key}`,
      );
      const thumbnailBuffer = await generateImageThumbnail(sourceBuffer);
      await uploadBufferToS3(s3, bucket, thumbnailKey, thumbnailBuffer, "image/jpeg");
      await sql`
        update files set thumbnail_key = ${thumbnailKey}, duration_seconds = null, width = null, height = null
        where id = ${fileId}
      `;
    }
  } catch (err) {
    console.warn(`  [thumb] Failed for ${fileId}:`, (err as Error).message);
  }
}

// ── Walk Drive tree ───────────────────────────────────────────────────────────

type FileTask = {
  driveFile: DriveFile;
  vaultFolderId: string | null;
};

async function walkDriveFolder(
  drive: ReturnType<typeof google.drive>,
  sql: ReturnType<typeof makeDb>,
  driveFolderId: string,
  vaultParentId: string | null,
  folderName: string | null,
  fileTasks: FileTask[],
): Promise<void> {
  // Ensure Vault folder exists (skip for root — we treat root as null parent)
  let vaultFolderId = vaultParentId;
  if (folderName !== null) {
    vaultFolderId = await upsertFolder(sql, folderName, vaultParentId);
  }

  const children = await listDriveChildren(drive, driveFolderId);

  const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";
  const subfolders = children.filter((c) => c.mimeType === `${GOOGLE_APPS_PREFIX}folder`);
  // Skip native Google Workspace formats (Docs, Sheets, Slides, etc.) — they
  // require export rather than direct download and can't be stored as-is.
  const files = children.filter(
    (c) => !c.mimeType.startsWith(GOOGLE_APPS_PREFIX),
  );

  // Queue files for concurrent upload
  for (const f of files) fileTasks.push({ driveFile: f, vaultFolderId });

  // Recurse into subfolders (sequential is fine — folder count is small)
  for (const sub of subfolders) {
    await walkDriveFolder(drive, sql, sub.id, vaultFolderId, sub.name, fileTasks);
  }
}

// ── File-task cache ───────────────────────────────────────────────────────────

type TaskCache = {
  folderId: string;
  scannedAt: string;
  tasks: FileTask[];
};

function cachePath(folderId: string): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), ".drive-cache", `${folderId}.json`);
}

function loadTaskCache(folderId: string): FileTask[] | null {
  const p = cachePath(folderId);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const cache = JSON.parse(raw) as TaskCache;
    if (cache.folderId !== folderId) return null;
    console.log(`Using cached tree from ${cache.scannedAt} (pass --rescan to refresh)`);
    return cache.tasks;
  } catch {
    return null;
  }
}

function saveTaskCache(folderId: string, tasks: FileTask[]): void {
  const p = cachePath(folderId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cache: TaskCache = { folderId, scannedAt: new Date().toISOString(), tasks };
  fs.writeFileSync(p, JSON.stringify(cache), "utf8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { folderId: rootDriveFolderId, rescan } = parseArgs();

  const keyPath = requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH");
  const databaseUrl = requireEnv("DATABASE_URL");
  const awsRegion = requireEnv("AWS_REGION");
  const awsAccessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  const s3Bucket = requireEnv("S3_BUCKET_NAME");

  // Google Drive client
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  const sql = makeDb(databaseUrl);
  const s3 = makeS3(awsRegion, awsAccessKeyId, awsSecretAccessKey);

  console.log(`\nWraptor Vault — Drive Migration`);
  console.log(`Drive folder: ${rootDriveFolderId}`);
  console.log(`S3 bucket:    ${s3Bucket}\n`);

  // Create the run row immediately so the web modal appears during the tree walk
  const runId = await createMigrationRun(sql, 0);
  console.log(`Migration run ID: ${runId}\n`);

  // ── Phase 1: walk the tree (or load from cache) ──────────────────────────
  let fileTasks: FileTask[];
  const cached = !rescan && loadTaskCache(rootDriveFolderId);
  if (cached) {
    fileTasks = cached;
    console.log(`Found ${fileTasks.length} file(s) to process (from cache).\n`);
  } else {
    console.log("Walking Drive folder tree…");
    fileTasks = [];
    await walkDriveFolder(drive, sql, rootDriveFolderId, null, null, fileTasks);
    saveTaskCache(rootDriveFolderId, fileTasks);
    console.log(`Found ${fileTasks.length} file(s) to process.\n`);
  }

  // ── Phase 2: upload files concurrently ───────────────────────────────────
  let migrated = 0;
  let skipped = 0;
  const failed: { name: string; reason: string }[] = [];
  let processed = 0;
  const total = fileTasks.length;

  // Update total now that we know it
  await sql`update migration_runs set total = ${total}, updated_at = now() where id = ${runId}`;

  const LARGE_WORKERS = 2;
  const SMALL_WORKERS = 6;

  const largeTasks = fileTasks.filter((t) => Number(t.driveFile.size ?? 0) > LARGE_FILE_TEMP_BYTES);
  const smallTasks = fileTasks.filter((t) => Number(t.driveFile.size ?? 0) <= LARGE_FILE_TEMP_BYTES);
  console.log(`  ${largeTasks.length} large (>500 MB) → ${LARGE_WORKERS} workers`);
  console.log(`  ${smallTasks.length} small           → ${SMALL_WORKERS} workers\n`);

  const workerSlots: WorkerSlot[] = new Array(LARGE_WORKERS + SMALL_WORKERS).fill(null);
  const workerFlusher = makeWorkerFlusher(sql, runId, workerSlots);

  const processFile = async ({ driveFile, vaultFolderId }: FileTask, slotIndex: number) => {
    processed++;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    const counter = `[${processed}/${total} ${pct}%]`;
    const label = driveFile.name;

    // Resolve folder name for display
    let folderName: string | null = null;
    if (vaultFolderId) {
      const rows = await sql<Row[]>`select name from folders where id = ${vaultFolderId} limit 1`;
      folderName = rows[0]?.name as string ?? null;
    }

    workerSlots[slotIndex] = { file: label, folder: folderName, pct: 0 };
    workerFlusher.mark();

    try {
      // Idempotency check
      const exists = await fileExistsInFolder(sql, driveFile.name, vaultFolderId);
      if (exists) {
        console.log(`${counter} Skipped (already exists): ${label}`);
        skipped++;
        workerSlots[slotIndex] = null;
        await updateMigrationProgress(sql, { runId, total, processed, migrated, skipped, failed: failed.length }, label, folderName);
        return;
      }

      // Determine extension + S3 key
      const ext = path.extname(driveFile.name).replace(/^\./, "") || "bin";
      const s3Key = `footage/${randomUUID()}.${ext}`;
      const mimeType = driveFile.mimeType;
      const mediaType = mediaTypeFromContentType(mimeType);
      const sizeBytes = driveFile.size ? Number(driveFile.size) : 0;

      if (sizeBytes >= LARGE_FILE_WARN_BYTES) {
        console.warn(`  [warn] Very large file (${(sizeBytes / 1024 ** 3).toFixed(1)} GB): ${label}`);
      }

      await updateMigrationProgress(sql, { runId, total, processed, migrated, skipped, failed: failed.length }, label, folderName);

      const setSlot = (pct: number) => {
        workerSlots[slotIndex] = { file: label, folder: folderName, pct };
        workerFlusher.mark();
      };

      if (sizeBytes > LARGE_FILE_TEMP_BYTES) {
        // Large file: download to temp disk first (Drive can't be stalled by S3 backpressure).
        // Progress: download = 0→50%, upload = 50→100%.
        const tmpPath = path.join(os.tmpdir(), `wraptor-${randomUUID()}`);
        try {
          await withRetry(async () => {
            const stream = await getDriveStream(drive, driveFile.id);
            let bytesWritten = 0;
            const counter = new PassThrough();
            counter.on("data", (chunk: Buffer) => {
              bytesWritten += chunk.length;
              if (sizeBytes > 0) setSlot(Math.round((bytesWritten / sizeBytes) * 50));
            });
            await pipeline(stream, counter, fs.createWriteStream(tmpPath));
          }, 3, `download ${label}`);
          await streamToS3(s3, s3Bucket, s3Key, fs.createReadStream(tmpPath), mimeType, (uploadPct) => {
            setSlot(50 + Math.round(uploadPct / 2));
          }, sizeBytes);
        } finally {
          fs.unlink(tmpPath, () => {});
        }
      } else {
        // Small/medium file: stream directly Drive → S3.
        // Passing ContentLength lets the SDK report accurate progress.
        await withRetry(async () => {
          const stream = await getDriveStream(drive, driveFile.id);
          setSlot(0);
          await streamToS3(s3, s3Bucket, s3Key, stream, mimeType, setSlot, sizeBytes || undefined);
        }, 3, `stream ${label}`);
      }

      // Insert DB record
      const fileId = await insertFile(sql, {
        s3Key,
        displayName: driveFile.name,
        mimeType,
        mediaType,
        sizeBytes,
        folderId: vaultFolderId,
      });

      // Thumbnails (fire-and-forget per file, errors are logged inside)
      await runThumbnail(fileId, s3Key, mediaType, s3, s3Bucket, sql);

      workerSlots[slotIndex] = { file: label, folder: folderName, pct: 100 };
      workerFlusher.mark();
      console.log(`${counter} Uploaded: ${label}`);
      migrated++;
    } catch (err) {
      const reason = (err as Error).message;
      console.error(`${counter} FAILED: ${label} — ${reason}`);
      failed.push({ name: label, reason });
    }

    workerSlots[slotIndex] = null;
    await updateMigrationProgress(sql, { runId, total, processed, migrated, skipped, failed: failed.length }, label, folderName);
  };

  await Promise.all([
    pool(largeTasks, LARGE_WORKERS, (task, i) => processFile(task, i)),
    pool(smallTasks, SMALL_WORKERS, (task, i) => processFile(task, i + LARGE_WORKERS)),
  ]);

  workerFlusher.stop();
  await finishMigrationRun(sql, runId, failed.length > 0 ? "error" : "done");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────");
  console.log(`Total found:  ${total}`);
  console.log(`Migrated:     ${migrated}`);
  console.log(`Skipped:      ${skipped}`);
  console.log(`Failed:       ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed files:");
    for (const f of failed) console.log(`  • ${f.name}: ${f.reason}`);
  }
  console.log("──────────────────────────────────────\n");

  await sql.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
