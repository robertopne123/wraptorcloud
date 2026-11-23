import { S3Client } from "@aws-sdk/client-s3";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for Hetzner Object Storage`);
  return value;
}

export function createObjectStorage() {
  const provider = process.env.VAULT_OBJECT_STORAGE ?? "aws";
  if (provider === "aws" || provider === "hetzner") {
    return {
      client: new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        },
      }),
      bucket: process.env.S3_BUCKET_NAME ?? "",
    };
  }

  if (provider !== "hetzner-preview") throw new Error("Invalid VAULT_OBJECT_STORAGE value");
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("Hetzner preview requires an isolated database and deployment");
  }
  return createHetznerObjectStorage();
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
