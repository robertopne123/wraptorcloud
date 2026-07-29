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
      const status = (err as any)?.response?.status ?? (err as any)?.code;
      const isRateLimit = status === 429 || status === 403;
      // Rate-limit errors need a longer cooldown; other errors use exponential backoff.
      const delay = isRateLimit
        ? 12000 + Math.random() * 6000  // 12–18 s
        : 2000 * 2 ** (i - 1);          // 2 s, 4 s
      console.warn(`  Retry ${i}/${attempts - 1} for "${label}" in ${Math.round(delay / 1000)}s…${isRateLimit ? " (rate limited)" : ""}`);
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

// ── Async queue for live producer→consumer handoff ────────────────────────────

class AsyncQueue<T> {
  private items: T[] = [];
  private waiting: Array<(item: T | null) => void> = [];
  private closed = false;

  push(item: T) {
    const resolve = this.waiting.shift();
    if (resolve) resolve(item);
    else this.items.push(item);
  }

  async pull(): Promise<T | null> {
    if (this.items.length > 0) return this.items.shift()!;
    if (this.closed) return null;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  close() {
    this.closed = true;
    this.waiting.forEach((r) => r(null));
    this.waiting = [];
  }

  async drain(concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    const worker = async () => {
      for (;;) {
        const item = await this.pull();
        if (item === null) return;
        await fn(item);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
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
  rangeHeader?: string,
): Promise<Readable> {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream", ...(rangeHeader ? { headers: { Range: rangeHeader } } : {}) },
  );
  return res.data as Readable;
}

const RANGE_CHUNK = 256 * 1024 * 1024; // 256 MB per chunk
const RANGE_PARALLELISM = 2;           // parallel chunks per large file

// Downloads a file using parallel byte-range requests, then concatenates.
// Multiplies effective download bandwidth when Drive throttles per-connection speed.
async function downloadInChunks(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  sizeBytes: number,
  destPath: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  const chunks: { start: number; end: number; idx: number }[] = [];
  for (let start = 0; start < sizeBytes; start += RANGE_CHUNK) {
    chunks.push({ start, end: Math.min(start + RANGE_CHUNK - 1, sizeBytes - 1), idx: chunks.length });
  }

  // Single chunk — no benefit from splitting; stream normally.
  if (chunks.length <= 1) {
    const stream = await getDriveStream(drive, fileId);
    let bytes = 0;
    const pt = new PassThrough();
    pt.on("data", (c: Buffer) => { bytes += c.length; onProgress(Math.round((bytes / sizeBytes) * 100)); });
    await pipeline(stream, pt, fs.createWriteStream(destPath));
    return;
  }

  const chunkPaths = chunks.map((c) => `${destPath}.c${c.idx}`);
  let bytesReceived = 0;

  try {
    await pool(chunks, RANGE_PARALLELISM, async ({ start, end, idx }) => {
      await withRetry(async () => {
        const stream = await getDriveStream(drive, fileId, `bytes=${start}-${end}`);
        const pt = new PassThrough();
        pt.on("data", (c: Buffer) => {
          bytesReceived += c.length;
          onProgress(Math.round((bytesReceived / sizeBytes) * 100));
        });
        await pipeline(stream, pt, fs.createWriteStream(chunkPaths[idx]));
      }, 3, `chunk-${idx} of ${fileId}`);
    });

    // Concatenate chunks in order into the destination file.
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      out.on("finish", resolve);
      out.on("error", reject);
      (async () => {
        for (const cp of chunkPaths) {
          await new Promise<void>((res, rej) => {
            const inp = fs.createReadStream(cp);
            inp.on("error", rej);
            inp.on("end", res);
            inp.pipe(out, { end: false });
          });
        }
        out.end();
      })().catch(reject);
    });
  } finally {
    chunkPaths.forEach((p) => fs.unlink(p, () => {}));
  }
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

// Unified flusher — writes worker slots + progress counters on a fixed interval.
// One DB write per tick regardless of worker count, avoiding connection contention.
function makeStateFlusher(
  sql: ReturnType<typeof makeDb>,
  runId: string,
  slots: WorkerSlot[],
  getProgress: () => { total: number; processed: number; migrated: number; skipped: number; failed: number },
) {
  let dirty = false;
  const flush = async () => {
    const { total, processed, migrated, skipped, failed } = getProgress();
    const workers = sql.json(slots.filter(Boolean));
    await sql`update migration_runs set workers = ${workers}, total = ${total},
      processed = ${processed}, migrated = ${migrated}, skipped = ${skipped},
      failed = ${failed}, updated_at = now() where id = ${runId}`;
  };
  const interval = setInterval(async () => {
    if (!dirty) return;
    dirty = false;
    try { await flush(); } catch { /* non-fatal */ }
  }, 500);
  return {
    mark() { dirty = true; },
    async flushNow() { dirty = false; await flush(); },
    stop() { clearInterval(interval); },
  };
}

function makeDb(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 0,
    keep_alive: 30,
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
  partSize = 8 * 1024 * 1024, // 8 MB default — small enough to show progress on most files
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
    partSize,
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

  const LARGE_WORKERS = 2;
  const SMALL_WORKERS = 4;
  const THUMB_WORKERS = 2;
  const LARGE_PART_SIZE = 32 * 1024 * 1024;

  const largeTasks = fileTasks.filter((t) => Number(t.driveFile.size ?? 0) > LARGE_FILE_TEMP_BYTES);
  const smallTasks = fileTasks.filter((t) => Number(t.driveFile.size ?? 0) <= LARGE_FILE_TEMP_BYTES);
  console.log(`  ${largeTasks.length} large (>500 MB) → ${LARGE_WORKERS} workers`);
  console.log(`  ${smallTasks.length} small           → ${SMALL_WORKERS} workers\n`);

  // Bulk-load all existing file keys → O(1) existence check, no per-file DB query
  console.log("Loading existing file index…");
  const existingRows = await sql<{ display_name: string; folder_id: string | null }[]>`
    select display_name, folder_id from files where deleted_at is null
  `;
  const existingKeys = new Set(existingRows.map((r) => `${r.folder_id ?? ""}:${r.display_name}`));
  console.log(`  ${existingKeys.size} files already in vault\n`);

  // Bulk-load all folder names → no per-file DB query
  const folderRows = await sql<{ id: string; name: string }[]>`select id, name from folders`;
  const folderNames = new Map(folderRows.map((r) => [r.id, r.name]));
  const getFolderName = (folderId: string | null) => (folderId ? (folderNames.get(folderId) ?? null) : null);

  const workerSlots: WorkerSlot[] = new Array(LARGE_WORKERS + SMALL_WORKERS).fill(null);
  const flusher = makeStateFlusher(sql, runId, workerSlots,
    () => ({ total, processed, migrated, skipped, failed: failed.length }),
  );

  // Live thumbnail queue — thumbnails start as soon as each file is uploaded
  type ThumbnailTask = { fileId: string; s3Key: string; mediaType: "video" | "image" | "other" };
  const thumbQueue = new AsyncQueue<ThumbnailTask>();
  let thumbDone = 0;

  const processFile = async ({ driveFile, vaultFolderId }: FileTask, slotIndex: number) => {
    processed++;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    const counter = `[${processed}/${total} ${pct}%]`;
    const label = driveFile.name;
    const folderName = getFolderName(vaultFolderId);

    workerSlots[slotIndex] = { file: label, folder: folderName, pct: 0 };
    flusher.mark();

    try {
      if (existingKeys.has(`${vaultFolderId ?? ""}:${driveFile.name}`)) {
        console.log(`${counter} Skipped (already exists): ${label}`);
        skipped++;
        workerSlots[slotIndex] = null;
        flusher.mark();
        return;
      }

      const ext = path.extname(driveFile.name).replace(/^\./, "") || "bin";
      const s3Key = `footage/${randomUUID()}.${ext}`;
      const mimeType = driveFile.mimeType;
      const mediaType = mediaTypeFromContentType(mimeType);
      const sizeBytes = driveFile.size ? Number(driveFile.size) : 0;

      if (sizeBytes >= LARGE_FILE_WARN_BYTES) {
        console.warn(`  [warn] Very large file (${(sizeBytes / 1024 ** 3).toFixed(1)} GB): ${label}`);
      }

      const setSlot = (pct: number) => {
        workerSlots[slotIndex] = { file: label, folder: folderName, pct };
        flusher.mark();
      };

      if (sizeBytes > LARGE_FILE_TEMP_BYTES) {
        const tmpPath = path.join(os.tmpdir(), `wraptor-${randomUUID()}`);
        try {
          // Download phase (0→50%): single stream to avoid chunk temp-file disk pressure.
          await withRetry(async () => {
            const stream = await getDriveStream(drive, driveFile.id);
            let bytesWritten = 0;
            const pt = new PassThrough();
            pt.on("data", (c: Buffer) => {
              bytesWritten += c.length;
              if (sizeBytes > 0) setSlot(Math.round((bytesWritten / sizeBytes) * 50));
            });
            await pipeline(stream, pt, fs.createWriteStream(tmpPath));
          }, 3, `download ${label}`);
          // Upload phase (50→100%).
          await streamToS3(s3, s3Bucket, s3Key, fs.createReadStream(tmpPath), mimeType,
            (uploadPct) => setSlot(50 + Math.round(uploadPct / 2)),
            sizeBytes, LARGE_PART_SIZE,
          );
        } finally {
          fs.unlink(tmpPath, () => {});
        }
      } else {
        await withRetry(async () => {
          const stream = await getDriveStream(drive, driveFile.id);
          setSlot(0);
          await streamToS3(s3, s3Bucket, s3Key, stream, mimeType, setSlot, sizeBytes || undefined);
        }, 3, `stream ${label}`);
      }

      const fileId = await insertFile(sql, {
        s3Key, displayName: driveFile.name, mimeType, mediaType, sizeBytes, folderId: vaultFolderId,
      });

      if (mediaType !== "other") thumbQueue.push({ fileId, s3Key, mediaType });

      workerSlots[slotIndex] = { file: label, folder: folderName, pct: 100 };
      flusher.mark();
      console.log(`${counter} Uploaded: ${label}`);
      migrated++;
    } catch (err) {
      const reason = (err as Error).message;
      console.error(`${counter} FAILED: ${label} — ${reason}`);
      failed.push({ name: label, reason });
    }

    workerSlots[slotIndex] = null;
    flusher.mark();
  };

  const uploads = Promise.all([
    pool(largeTasks, LARGE_WORKERS, (task, i) => processFile(task, i)),
    pool(smallTasks, SMALL_WORKERS, (task, i) => processFile(task, i + LARGE_WORKERS)),
  ]);
  uploads.then(() => thumbQueue.close());

  await Promise.all([
    uploads,
    thumbQueue.drain(THUMB_WORKERS, async (task) => {
      await runThumbnail(task.fileId, task.s3Key, task.mediaType, s3, s3Bucket, sql);
      thumbDone++;
      if (thumbDone % 100 === 0) console.log(`  [thumbnails] ${thumbDone} done`);
    }),
  ]);

  await flusher.flushNow();
  flusher.stop();
  console.log(`  [thumbnails] ${thumbDone} total`);
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
