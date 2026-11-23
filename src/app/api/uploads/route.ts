import {
  CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  HeadObjectCommand, ListPartsCommand, UploadPartCommand, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { getObjectStorage } from "@/lib/s3";
import { uploadPartSize } from "@/lib/uploads/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { action, id, size, contentType, uploadId: sessionId, partNumber } = body ?? {};
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 ** 4
    || typeof contentType !== "string" || contentType.length === 0) {
    return NextResponse.json({ error: "Invalid upload details" }, { status: 400 });
  }
  if (!["start", "part", "complete"].includes(action)) {
    return NextResponse.json({ error: "Invalid upload action" }, { status: 400 });
  }
  // During the cutover these sessions used a separate object-key prefix.
  const prefixedSession = typeof sessionId === "string" && sessionId.startsWith("hetzner:");
  const uploadId = prefixedSession ? sessionId.slice("hetzner:".length) : sessionId;
  const { client: s3Client, bucket } = getObjectStorage();
  const params = { Bucket: bucket, Key: `${prefixedSession ? "hetzner/" : ""}footage/${id}` };
  const expectedParts = Math.ceil(size / uploadPartSize(size));

  try {
    // Multipart uploads cannot represent empty files, which archives often contain.
    if (size === 0 && action === "start") {
      await s3Client.send(new PutObjectCommand({ ...params, Body: Buffer.alloc(0), ContentType: contentType }));
      return NextResponse.json({ complete: true, s3Key: params.Key });
    }
    if (size === 0) return NextResponse.json({ error: "Empty files do not need multipart upload parts" }, { status: 400 });
    // Do not HEAD a new key: S3 returns 403 for missing objects when the
    // uploader has object access but no bucket-listing permission.
    if (action === "start" && !uploadId) {
      const result = await s3Client.send(new CreateMultipartUploadCommand({ ...params, ContentType: contentType }));
      return NextResponse.json({ uploadId: result.UploadId, parts: [], complete: false });
    }
    if (typeof uploadId !== "string" || uploadId.length === 0) {
      return NextResponse.json({ error: "uploadId is required" }, { status: 400 });
    }
    if (action === "part") {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedParts) {
        return NextResponse.json({ error: "Invalid part number" }, { status: 400 });
      }
      const url = await getSignedUrl(s3Client, new UploadPartCommand({ ...params, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 3600 });
      return NextResponse.json({ url });
    }

    const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
    let marker: string | undefined;
    do {
      const page = await s3Client.send(new ListPartsCommand({ ...params, UploadId: uploadId, PartNumberMarker: marker }));
      for (const part of page.Parts ?? []) {
        if (part.PartNumber !== undefined && part.ETag && part.Size !== undefined) {
          parts.push({ PartNumber: part.PartNumber, ETag: part.ETag, Size: part.Size });
        }
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    if (action === "start") {
      return NextResponse.json({ uploadId: sessionId, parts: parts.map((part) => part.PartNumber), complete: false });
    }
    const partSize = uploadPartSize(size);
    if (parts.length !== expectedParts || parts.some((part, index) =>
      part.PartNumber !== index + 1 || part.Size !== Math.min(partSize, size - index * partSize))) {
      return NextResponse.json({ error: "Upload is missing parts or contains invalid part sizes" }, { status: 409 });
    }
    await s3Client.send(new CompleteMultipartUploadCommand({ ...params, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) } }));
    return NextResponse.json({ complete: true, s3Key: params.Key });
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchUpload") {
      // Completion removes the multipart session. Only now inspect the
      // object to recover a successful completion whose response was lost.
      try {
        const object = await s3Client.send(new HeadObjectCommand(params));
        if (object.ContentLength !== size) {
          return NextResponse.json({ error: "Stored file size does not match upload" }, { status: 409 });
        }
        return NextResponse.json({ complete: true, s3Key: params.Key });
      } catch (lookupError) {
        const status = (lookupError as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode;
        if (status !== 404 && status !== 403) {
          console.error("[uploads] recovery", id, lookupError);
          return NextResponse.json({ error: "Could not check the completed upload. Please retry." }, { status: 503 });
        }
      }
      return NextResponse.json({ error: "Upload session expired", code: "NoSuchUpload" }, { status: 410 });
    }
    console.error("[uploads]", action, id, error);
    const failure = error as { name?: string; $metadata?: { httpStatusCode: number } };
    if (failure.name === "InvalidAccessKeyId" || failure.name === "SignatureDoesNotMatch") {
      return NextResponse.json({ error: "Object storage rejected the upload signature. Check the storage configuration." }, { status: 403 });
    }
    if (failure.$metadata?.httpStatusCode === 403) {
      return NextResponse.json({ error: "Object storage denied the upload. Check the bucket permissions." }, { status: 403 });
    }
    return NextResponse.json({ error: "Storage temporarily unavailable. Please retry." }, { status: 503 });
  }
}
