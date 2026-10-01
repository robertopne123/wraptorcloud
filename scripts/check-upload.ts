import { loadEnvConfig } from "@next/env";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

// Live smoke check: creates a temporary multipart upload, sends one small part,
// verifies recovery, then aborts it. Does not create an object or database row.
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

async function main() {
  const { POST } = await import("../src/app/api/uploads/route");
  const { s3Client, S3_BUCKET_NAME } = await import("../src/lib/s3");
  const id = randomUUID();
  const source = Buffer.from("Wraptor upload connection check");
  let uploadId: string | undefined;
  async function api(action: string, extra: Record<string, unknown> = {}) {
    const response = await POST(new Request("http://localhost/api/uploads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id, size: source.length, contentType: "application/octet-stream", uploadId, ...extra }),
    }));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }
  try {
    uploadId = (await api("start")).uploadId;
    if (!uploadId) throw new Error("Missing multipart session");
    const { url } = await api("part", { partNumber: 1 });
    const put = await fetch(url, { method: "PUT", body: source, signal: AbortSignal.timeout(30_000) });
    if (!put.ok) throw new Error(`S3 chunk PUT failed (${put.status})`);
    const resumed = await api("start");
    if (resumed.parts.length !== 1 || resumed.parts[0] !== 1) throw new Error("Could not recover uploaded part");
    console.log("Session creation, signed chunk upload and recovery succeeded.");
  } finally {
    if (uploadId) {
      await s3Client.send(new AbortMultipartUploadCommand({ Bucket: S3_BUCKET_NAME, Key: `footage/${id}`, UploadId: uploadId }));
      console.log("Temporary multipart upload aborted; no object or database row created.");
    }
    s3Client.destroy();
  }
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
