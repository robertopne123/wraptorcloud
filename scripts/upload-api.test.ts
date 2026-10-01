import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadPartSize } from "../src/lib/uploads/types";

test("multipart upload API", async (t) => {
  // No credentials or AWS requests are used in these tests.
  process.env.AWS_REGION = "eu-west-1";
  process.env.AWS_ACCESS_KEY_ID = "test-only";
  process.env.AWS_SECRET_ACCESS_KEY = "test-only";
  process.env.S3_BUCKET_NAME = "test-only";
  const { POST } = await import("../src/app/api/uploads/route");
  const { s3Client } = await import("../src/lib/s3");
  const originalSend = s3Client.send;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let handle: (name: string, input: Record<string, unknown>) => unknown;
  s3Client.send = (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    return handle(command.constructor.name, command.input);
  }) as typeof s3Client.send;
  const id = "ba21e02e-4104-4a0d-b4b4-e93b28ecf26f";
  const notFound = () => { throw { $metadata: { httpStatusCode: 404 } }; };
  async function post(extra: Record<string, unknown>) {
    return POST(new Request("http://localhost/api/uploads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, size: 10, contentType: "video/mp4", ...extra }),
    }));
  }
  try {
    await t.test("rejects malformed details before touching storage", async () => {
      calls.length = 0;
      assert.equal((await post({ action: "start", id: "../other-file" })).status, 400);
      assert.equal((await post({ action: "start", size: -1 })).status, 400);
      assert.equal((await post({ action: "part", partNumber: 0, uploadId: "session" })).status, 400);
      assert.equal((await post({ action: "unknown" })).status, 400);
      assert.equal(calls.length, 0);
    });
    await t.test("creates a multipart session using a stable object key", async () => {
      calls.length = 0;
      handle = (name) => name === "HeadObjectCommand" ? notFound() : { UploadId: "saved-session" };
      const response = await post({ action: "start" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { uploadId: "saved-session", parts: [], complete: false });
      assert.equal(calls[0].input.Key, `footage/${id}`);
      assert.ok(!calls.some((call) => call.name === "HeadObjectCommand"));
    });
    await t.test("stores empty archive files without starting multipart uploads", async () => {
      calls.length = 0;
      handle = () => ({});
      const response = await post({ action: "start", size: 0 });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).complete, true);
      assert.equal(calls[0].name, "PutObjectCommand");
      assert.equal((calls[0].input.Body as Buffer).length, 0);
      assert.equal((await post({ action: "part", size: 0, partNumber: 1 })).status, 400);
    });
    await t.test("accepts documents, audio, archives and unknown binary types", async () => {
      handle = () => ({ UploadId: "saved-session" });
      for (const contentType of ["application/pdf", "audio/mpeg", "application/zip", "application/octet-stream", "application/x-custom-format"]) {
        calls.length = 0;
        const response = await post({ action: "start", contentType });
        assert.equal(response.status, 200);
        assert.equal(calls[0].input.ContentType, contentType);
      }
    });
    await t.test("resuming paginates S3 parts beyond the first 1000", async () => {
      calls.length = 0;
      handle = (name, input) => {
        if (name === "HeadObjectCommand") return notFound();
        if (input.PartNumberMarker === "1000") return {
          Parts: [{ PartNumber: 1001, ETag: "last", Size: 1 }], IsTruncated: false,
        };
        return { Parts: Array.from({ length: 1000 }, (_, i) => ({ PartNumber: i + 1, ETag: `${i}`, Size: 10 })),
          IsTruncated: true, NextPartNumberMarker: "1000" };
      };
      const response = await post({ action: "start", uploadId: "saved-session" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).parts.length, 1001);
      assert.equal(calls.filter((call) => call.name === "ListPartsCommand").length, 2);
    });
    await t.test("completes only when every part has the expected size", async () => {
      calls.length = 0;
      const partSize = uploadPartSize(10);
      handle = (name) => {
        if (name === "HeadObjectCommand") return notFound();
        if (name === "ListPartsCommand") return { Parts: [
          { PartNumber: 1, ETag: "first", Size: partSize }, { PartNumber: 2, ETag: "second", Size: 5 },
        ] };
        return {};
      };
      const response = await post({ action: "complete", uploadId: "saved-session", size: partSize + 5 });
      assert.equal(response.status, 200);
      const completion = calls.find((call) => call.name === "CompleteMultipartUploadCommand")!;
      assert.deepEqual(completion.input.MultipartUpload, { Parts: [
        { PartNumber: 1, ETag: "first" }, { PartNumber: 2, ETag: "second" },
      ] });
    });
    await t.test("missing or truncated parts cannot produce a completed file", async () => {
      calls.length = 0;
      handle = (name) => name === "HeadObjectCommand" ? notFound() : { Parts: [{ PartNumber: 1, ETag: "bad", Size: 9 }] };
      assert.equal((await post({ action: "complete", uploadId: "saved-session" })).status, 409);
      assert.ok(!calls.some((call) => call.name === "CompleteMultipartUploadCommand"));
    });
    await t.test("lost completion responses recover from the already stored object", async () => {
      calls.length = 0;
      handle = (name) => {
        if (name === "ListPartsCommand") throw { name: "NoSuchUpload" };
        return { ContentLength: 10 };
      };
      const response = await post({ action: "complete", uploadId: "saved-session" });
      assert.deepEqual(await response.json(), { complete: true, s3Key: `footage/${id}` });
      assert.deepEqual(calls.map((call) => call.name), ["ListPartsCommand", "HeadObjectCommand"]);
    });
    await t.test("expired sessions return a recoverable error", async () => {
      handle = (name) => {
        if (name === "HeadObjectCommand") return notFound();
        throw { name: "NoSuchUpload" };
      };
      const response = await post({ action: "start", uploadId: "expired-session" });
      assert.equal(response.status, 410);
      assert.equal((await response.json()).code, "NoSuchUpload");
    });
    await t.test("missing objects without ListBucket permission still allow a new session", async () => {
      calls.length = 0;
      handle = (name) => {
        if (name === "HeadObjectCommand") throw { name: "AccessDenied", $metadata: { httpStatusCode: 403 } };
        return { UploadId: "new-session" };
      };
      const response = await post({ action: "start" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).uploadId, "new-session");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "CreateMultipartUploadCommand");
    });
    await t.test("expired sessions recover even when missing-object checks return 403", async () => {
      handle = (name) => {
        if (name === "HeadObjectCommand") throw { name: "AccessDenied", $metadata: { httpStatusCode: 403 } };
        throw { name: "NoSuchUpload" };
      };
      const response = await post({ action: "start", uploadId: "expired-session" });
      assert.equal(response.status, 410);
      assert.equal((await response.json()).code, "NoSuchUpload");
    });
  } finally { s3Client.send = originalSend; }
});
