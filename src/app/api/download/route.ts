import { NextResponse } from "next/server";
import { ZipArchive } from "archiver";
import { PassThrough, Readable } from "stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { listFilesForDownload } from "@/lib/db/queries";
import { s3Client, S3_BUCKET_NAME } from "@/lib/s3";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const fileIds: unknown = body?.fileIds;
  const folderIds: unknown = body?.folderIds;

  if (!Array.isArray(fileIds) || !Array.isArray(folderIds)) {
    return NextResponse.json({ error: "fileIds and folderIds must be arrays" }, { status: 400 });
  }

  if (fileIds.length === 0 && folderIds.length === 0) {
    return NextResponse.json({ error: "Nothing to download" }, { status: 400 });
  }

  const files = await listFilesForDownload({
    fileIds: fileIds.filter((x): x is string => typeof x === "string"),
    folderIds: folderIds.filter((x): x is string => typeof x === "string"),
  });

  if (files.length === 0) {
    return NextResponse.json({ error: "No files found" }, { status: 404 });
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);
  archive.on("error", (err: Error) => pass.destroy(err));

  // Add files to the archive sequentially, then finalize — runs alongside streaming.
  (async () => {
    for (const file of files) {
      try {
        const { Body } = await s3Client.send(
          new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: file.s3_key }),
        );
        if (Body) {
          archive.append(Body as unknown as Readable, { name: file.display_name });
        }
      } catch (err) {
        console.error("[download] Skipping file", file.id, err);
      }
    }
    archive.finalize();
  })();

  const filename =
    files.length === 1
      ? files[0].display_name.replace(/\.[^/.]+$/, "") + ".zip"
      : "vault-download.zip";

  return new Response(Readable.toWeb(pass) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
