import path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { google } from "googleapis";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mediaTypeFromContentType } from "../src/lib/media.js";

dotenv.config({ path: ".env.local" });

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): { folderId: string } {
  const arg = process.argv.find((a) => a.startsWith("--folder-id="));
  if (!arg) {
    console.error("Usage: npx tsx scripts/migrate-from-drive.ts --folder-id=<drive-folder-id>");
    process.exit(1);
  }
  return { folderId: arg.slice("--folder-id=".length) };
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
      const delay = 500 * 2 ** (i - 1);
      console.warn(`  Retry ${i}/${attempts - 1} for "${label}" in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
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

async function downloadDriveFile(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  label: string,
): Promise<Buffer> {
  return withRetry(async () => {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }, 3, `download ${label}`);
}

// ── DB helpers (inline, no shared singleton) ──────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(databaseUrl: string) {
  return postgres(databaseUrl, { max: 5 });
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

async function uploadToS3(
  s3: S3Client,
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string,
) {
  return withRetry(
    () =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType })),
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
      await uploadToS3(s3, bucket, thumbnailKey, thumbnailBuffer, "image/jpeg");
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
      await uploadToS3(s3, bucket, thumbnailKey, thumbnailBuffer, "image/jpeg");
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { folderId: rootDriveFolderId } = parseArgs();

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

  // ── Phase 1: walk the tree, collect file tasks ────────────────────────────
  console.log("Walking Drive folder tree…");
  const fileTasks: FileTask[] = [];
  await walkDriveFolder(drive, sql, rootDriveFolderId, null, null, fileTasks);
  console.log(`Found ${fileTasks.length} file(s) to process.\n`);

  // ── Phase 2: upload files concurrently ───────────────────────────────────
  let migrated = 0;
  let skipped = 0;
  const failed: { name: string; reason: string }[] = [];
  let processed = 0;
  const total = fileTasks.length;

  await pool(fileTasks, 4, async ({ driveFile, vaultFolderId }) => {
    processed++;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
    const counter = `[${processed}/${total} ${pct}%]`;
    const label = driveFile.name;

    try {
      // Idempotency check
      const exists = await fileExistsInFolder(sql, driveFile.name, vaultFolderId);
      if (exists) {
        console.log(`${counter} Skipped (already exists): ${label}`);
        skipped++;
        return;
      }

      // Download from Drive
      const buffer = await downloadDriveFile(drive, driveFile.id, label);

      // Determine extension + S3 key
      const ext = path.extname(driveFile.name).replace(/^\./, "") || "bin";
      const s3Key = `footage/${randomUUID()}.${ext}`;
      const mimeType = driveFile.mimeType;
      const mediaType = mediaTypeFromContentType(mimeType);
      const sizeBytes = buffer.byteLength;

      // Upload to S3
      await uploadToS3(s3, s3Bucket, s3Key, buffer, mimeType);

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

      console.log(`${counter} Uploaded: ${label}`);
      migrated++;
    } catch (err) {
      const reason = (err as Error).message;
      console.error(`${counter} FAILED: ${label} — ${reason}`);
      failed.push({ name: label, reason });
    }
  });

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
