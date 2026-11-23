import { S3Client } from "@aws-sdk/client-s3";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for Hetzner Object Storage`);
  return value;
}

export function createHetznerObjectStorage() {
  const endpoint = new URL(required("HETZNER_S3_ENDPOINT"));
  if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.your-objectstorage\.com$/.test(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/"
    || endpoint.search || endpoint.hash) {
    throw new Error("HETZNER_S3_ENDPOINT must be a Hetzner regional HTTPS endpoint");
  }

  return {
    client: new S3Client({
      endpoint: endpoint.origin,
      region: required("HETZNER_S3_REGION"),
      credentials: {
        accessKeyId: required("HETZNER_S3_ACCESS_KEY_ID"),
        secretAccessKey: required("HETZNER_S3_SECRET_ACCESS_KEY"),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
    bucket: required("HETZNER_S3_BUCKET"),
  };
}
