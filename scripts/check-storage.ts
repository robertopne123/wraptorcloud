import { loadEnvConfig } from "@next/env";
import { GetObjectCommand, HeadBucketCommand, ListPartsCommand, S3Client } from "@aws-sdk/client-s3";

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "" },
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 10000, requestTimeout: 15000 },
});

async function main() {
  for (const [check, run] of [
    ["bucket", () => client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET_NAME }))],
    ["missing-object", () => client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: "footage/__connection_check__" }))],
    ["multipart-permission", () => client.send(new ListPartsCommand({ Bucket: process.env.S3_BUCKET_NAME,
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
