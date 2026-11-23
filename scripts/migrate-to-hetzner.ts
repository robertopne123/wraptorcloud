import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import {
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, paginateListObjectsV2,
  S3Client, type _Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createHetznerObjectStorage } from "../src/lib/storage-config";
import { startDashboard, type MigrationProgress, type ObjectProgress } from "./hetzner-migration-dashboard";

const MiB = 1024 ** 2;

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const code = status(error);
  return code ? `${error.name} (HTTP ${code})` : error.message;
}

async function* hashStream(source: Readable, digest: ReturnType<typeof createHash>) {
  for await (const chunk of source) {
    digest.update(chunk);
    yield chunk;
  }
}

async function checksum(source: Readable, progress: ObjectProgress): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of source) {
    digest.update(chunk);
    progress.phaseBytes += chunk.length;
  }
  return digest.digest("hex");
}

async function copyObject(
  source: S3Client, sourceBucket: string, destination: S3Client, destinationBucket: string, object: _Object,
  progress: ObjectProgress,
): Promise<"copied" | "verified-existing"> {
  const { Key, Size, ETag } = object;
  if (Key === undefined || Size === undefined || !ETag) throw new Error("Incomplete source listing entry");
  const target = { Bucket: destinationBucket, Key };
  // HEAD on a missing key requires ListBucket access to return 404. Any other
  // response is a failure and must never be interpreted as permission to write.
  const existing = await destination.send(new HeadObjectCommand(target)).catch((error: unknown) => {
    if (status(error) !== 404) throw error;
    return null;
  });
  if (existing && existing.ContentLength !== Size) throw new Error("Destination already exists with a different size");

  const original = await source.send(new GetObjectCommand({ Bucket: sourceBucket, Key, IfMatch: ETag }));
  if (!(original.Body instanceof Readable)) throw new Error("Missing source stream");
  const sourceBody = original.Body;
  try {
    if (original.ContentLength !== Size) throw new Error("Source size changed since listing");
    let sourceChecksum: string;
    if (existing) {
      progress.phase = "Reading AWS source";
      sourceChecksum = await checksum(sourceBody, progress);
    } else {
      progress.phase = "Copying to Hetzner";
      const digest = createHash("sha256");
      const uploadBody = Readable.from(hashStream(sourceBody, digest), { objectMode: false });
      try {
        await new Upload({
          client: destination,
          params: {
            ...target, Body: uploadBody, ContentLength: Size, IfNoneMatch: "*",
            ContentType: original.ContentType, ContentDisposition: original.ContentDisposition,
            ContentEncoding: original.ContentEncoding, ContentLanguage: original.ContentLanguage,
            CacheControl: original.CacheControl, Expires: original.Expires, Metadata: original.Metadata,
          },
          partSize: Math.max(64, Math.ceil(Size / 9999 / MiB)) * MiB,
          queueSize: 2,
        }).on("httpUploadProgress", ({ loaded }) => {
          progress.phaseBytes = loaded ?? progress.phaseBytes;
        }).done();
      } finally {
        uploadBody.destroy();
      }
      sourceChecksum = digest.digest("hex");
    }

    progress.phase = "Verifying Hetzner copy";
    progress.phaseBytes = 0;
    const copied = await destination.send(new GetObjectCommand({ ...target, IfMatch: existing?.ETag }));
    if (!(copied.Body instanceof Readable)) throw new Error("Missing destination stream");
    try {
      if (copied.ContentLength !== Size || await checksum(copied.Body, progress) !== sourceChecksum) {
        throw new Error("Destination content verification failed");
      }
    } finally {
      copied.Body.destroy();
    }
    return existing ? "verified-existing" : "copied";
  } finally {
    sourceBody.destroy();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    copy: { type: "boolean" }, prefix: { type: "string" }, help: { type: "boolean" }, watch: { type: "boolean" },
    transfers: { type: "string", default: "1" },
  } });
  if (values.help) {
    console.log("Usage: npm run migrate:hetzner -- [--prefix footage/] [--copy] [--watch] [--transfers 4]\nDefault: read-only inventory. Pass --copy to transfer and verify objects, and --watch for a local dashboard.");
    return;
  }
  const transfers = Number(values.transfers);
  if (!Number.isInteger(transfers) || transfers < 1 || transfers > 16) throw new Error("--transfers must be an integer from 1 to 16");

  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const sourceBucket = process.env.S3_BUCKET_NAME;
  if (!sourceBucket || !process.env.AWS_REGION) throw new Error("Set S3_BUCKET_NAME and AWS_REGION for the source bucket");
  const { client: destination, bucket: destinationBucket } = createHetznerObjectStorage();
  const source = new S3Client({ region: process.env.AWS_REGION });
  const totals = { objects: 0, bytes: 0, copied: 0, verifiedExisting: 0, failed: 0 };
  const progress: MigrationProgress = {
    mode: values.copy ? "copy" : "inventory", state: "running", phase: "Checking Hetzner destination bucket",
    active: [], totals, recent: [],
  };
  async function transfer(object: _Object, bucket: string) {
    const file: ObjectProgress = {
      key: object.Key ?? "Unknown key", fileBytes: object.Size ?? 0, phaseBytes: 0,
      phase: "Checking destination object",
    };
    progress.active.push(file);
    try {
      const result = await copyObject(source, bucket, destination, destinationBucket, object, file);
      if (result === "copied") totals.copied++;
      else totals.verifiedExisting++;
      progress.recent.unshift({ key: file.key, result });
      console.log(JSON.stringify({ result, key: object.Key, bytes: object.Size }));
    } catch (error) {
      totals.failed++;
      const detail = describe(error);
      progress.recent.unshift({ key: file.key, result: `Failed: ${detail}` });
      console.error(JSON.stringify({ result: "failed", key: object.Key, error: detail }));
    } finally {
      progress.active.splice(progress.active.indexOf(file), 1);
      if (progress.recent.length > 15) progress.recent.pop();
    }
  }
  try {
    if (values.watch) await startDashboard(progress);
    await destination.send(new HeadBucketCommand({ Bucket: destinationBucket }));
    progress.phase = "Listing AWS objects";
    console.log(JSON.stringify({ mode: progress.mode, sourceBucket, destinationBucket, prefix: values.prefix ?? "" }));
    for await (const page of paginateListObjectsV2({ client: source }, { Bucket: sourceBucket, Prefix: values.prefix })) {
      const objects = page.Contents ?? [];
      for (const object of objects) {
        totals.objects++;
        totals.bytes += object.Size ?? 0;
      }
      if (!values.copy) continue;
      progress.phase = "Copying and verifying objects";
      const pending = objects.values();
      await Promise.all(Array.from({ length: Math.min(transfers, objects.length) }, async () => {
        for (const object of pending) await transfer(object, sourceBucket);
      }));
      progress.phase = "Listing AWS objects";
    }
    progress.state = totals.failed ? "failed" : "done";
    progress.phase = totals.failed ? "Completed with failures" : "Completed";
  } catch (error) {
    progress.state = "failed";
    const denied = status(error) === 403;
    const permission = progress.phase === "Listing AWS objects"
      ? "Check s3:ListBucket on the AWS source bucket."
      : "Check access to the configured Hetzner bucket.";
    progress.phase = `${progress.phase}: ${describe(error)}${denied ? `. ${permission}` : ""}`;
    throw new Error(progress.phase);
  } finally {
    source.destroy();
    destination.destroy();
    console.log(JSON.stringify(totals));
  }
  if (totals.failed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(describe(error));
  process.exitCode = 1;
});
