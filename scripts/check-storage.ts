import { loadEnvConfig } from "@next/env";
import { GetObjectCommand, HeadBucketCommand, ListPartsCommand } from "@aws-sdk/client-s3";
import { createHetznerObjectStorage } from "../src/lib/storage-config";

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const { client, bucket } = createHetznerObjectStorage();

async function main() {
  for (const [check, run] of [
    ["bucket", () => client.send(new HeadBucketCommand({ Bucket: bucket }))],
    ["missing-object", () => client.send(new GetObjectCommand({ Bucket: bucket, Key: "footage/__connection_check__" }))],
    ["multipart-permission", () => client.send(new ListPartsCommand({ Bucket: bucket,
      Key: "footage/__connection_check__", UploadId: "connection-check" }))],
  ] as const) {
    try {
      const result = await run();
      if ("Body" in result) (result.Body as { destroy?: () => void })?.destroy?.();
      console.log(JSON.stringify({ check, ok: true }));
    } catch (error) {
      const failure = error as { name: string; code?: string; message: string;
        $metadata?: { httpStatusCode: number }; $response?: { headers: Record<string, string> } };
      console.log(JSON.stringify({ check, name: failure.name, code: failure.code,
        status: failure.$metadata?.httpStatusCode, message: failure.message,
        bucketRegion: failure.$response?.headers["x-amz-bucket-region"] }));
    }
  }
  client.destroy();
}

void main();
