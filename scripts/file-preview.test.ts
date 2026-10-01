import assert from "node:assert/strict";
import { test } from "node:test";
import AdmZip from "adm-zip";
import tar from "tar-stream";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { archivePath, readArchive, MAX_EXPANDED_BYTES } from "../src/lib/archive";
import { previewKind } from "../src/lib/preview-types";
import type { FileRecord } from "../src/lib/db/types";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWaveform } from "../src/lib/audio-waveform";

async function tarBuffer() {
  const pack = tar.pack();
  pack.entry({ name: "./", type: "directory" });
  pack.entry({ name: "nested/", type: "directory" });
  pack.entry({ name: "nested/readme.txt" }, "hello");
  pack.entry({ name: "empty.txt" }, "");
  pack.finalize();
  const buffers: Buffer[] = [];
  for await (const chunk of pack) buffers.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(buffers);
}

test("preview kinds recognize generic MIME types from file extensions", () => {
  for (const [name, kind] of [["book.PDF", "pdf"], ["report.docx", "document"], ["budget.xlsx", "spreadsheet"], ["note.md", "text"], ["song.flac", "audio"], ["backup.tar.gz", "archive"], ["image.raw", "unsupported"]]) {
    assert.equal(previewKind(name, "application/octet-stream"), kind);
  }
  assert.equal(previewKind("unknown", "audio/mpeg"), "audio");
});

test("audio waveforms use real samples and cover the full playback timeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wraptor-waveform-"));
  try {
    const rate = 8000;
    const duration = 2.5;
    const samples = rate * duration;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index++) wav.writeInt16LE(index < samples / 2 ? 0 : Math.round(Math.sin(index * Math.PI * 2 * 100 / rate) * 16000), 44 + index * 2);
    const path = join(directory, "sample.wav");
    await writeFile(path, wav);
    const waveform = await generateWaveform(path, path);
    assert.ok(Math.abs(waveform.duration - duration) < 0.1);
    assert.equal(waveform.peaks.length, 1000);
    assert.ok(waveform.peaks.slice(0, 400).every((peak) => peak < 0.01));
    assert.ok(waveform.peaks.slice(600).every((peak) => peak > 0.5));
    assert.deepEqual(await generateWaveform(path, path), waveform);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ZIP archives list nested files, empty files and directories without extracting to disk", async () => {
  const zip = new AdmZip();
  zip.addFile("nested/", Buffer.alloc(0));
  zip.addFile("nested/readme.txt", Buffer.from("hello"));
  zip.addFile("empty.txt", Buffer.alloc(0));
  const entries = await readArchive(zip.toBuffer(), "archive.zip");
  assert.equal(entries.length, 3);
  assert.equal(entries.find((entry) => entry.path === "nested")?.directory, true);
  assert.equal(entries.find((entry) => entry.path === "nested/readme.txt")?.read().toString(), "hello");
  assert.equal(entries.find((entry) => entry.path === "empty.txt")?.read().length, 0);
});

test("TAR, compressed TAR and standalone gzip entries preserve their contents", async () => {
  const source = await tarBuffer();
  for (const [buffer, name] of [[source, "backup.tar"], [gzipSync(source), "backup.tgz"]] as const) {
    const entries = await readArchive(buffer, name);
    assert.equal(entries.length, 3);
    assert.equal(entries.find((entry) => entry.path === "nested/readme.txt")?.read().toString(), "hello");
    assert.equal(entries.find((entry) => entry.path === "empty.txt")?.size, 0);
  }
  const entries = await readArchive(gzipSync(Buffer.from("hello")), "readme.txt.gz");
  assert.equal(entries[0].path, "readme.txt");
  assert.equal(entries[0].read().toString(), "hello");
});

test("unsafe archive paths and symbolic links are rejected", async () => {
  for (const path of ["../outside", "/absolute", "C:\\file", "a/../../b", "a//b", "a\0b"]) {
    assert.throws(() => archivePath(path), /unsafe/);
  }
  assert.equal(archivePath("./nested\\file.txt"), "nested/file.txt");
  const pack = tar.pack();
  pack.entry({ name: "link", type: "symlink", linkname: "../outside" });
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  await assert.rejects(readArchive(Buffer.concat(chunks), "links.tar"), /links/);
});

test("archive limits reject expansion bombs, password flags and conflicting paths", async () => {
  const zip = new AdmZip();
  zip.addFile("file.txt", Buffer.from("hello"));
  const huge = zip.toBuffer();
  const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(MAX_EXPANDED_BYTES + 1, central + 24);
  await assert.rejects(readArchive(huge, "huge.zip"), /250 MB/);
  const encrypted = zip.toBuffer();
  encrypted.writeUInt16LE(1, central + 8);
  await assert.rejects(readArchive(encrypted, "encrypted.zip"), /Password/);
  const conflicts = new AdmZip();
  conflicts.addFile("a", Buffer.from("file"));
  conflicts.addFile("a/b", Buffer.from("nested"));
  await assert.rejects(readArchive(conflicts.toBuffer(), "conflict.zip"), /conflicting/);
  await assert.rejects(readArchive(Buffer.from("bad"), "broken.zip"));
});

test("document previews render text, Word content and workbook sheets from storage", async () => {
  process.env.AWS_REGION = "eu-west-1";
  process.env.AWS_ACCESS_KEY_ID = "test-only";
  process.env.AWS_SECRET_ACCESS_KEY = "test-only";
  process.env.S3_BUCKET_NAME = "test-only";
  const { previewFile, archiveEntry } = await import("../src/lib/file-preview");
  const { s3Client } = await import("../src/lib/s3");
  const original = s3Client.send;
  let buffer: Buffer = Buffer.from("<script>text is rendered as text</script>");
  let reads = 0;
  s3Client.send = (async () => { reads++; return { Body: Readable.from([buffer]) }; }) as typeof s3Client.send;
  const file = (name: string): FileRecord => ({ display_name: name, mime_type: "application/octet-stream", size_bytes: String(buffer.length), s3_key: name } as FileRecord);
  try {
    const text = await previewFile(file("notes.txt"));
    assert.equal(text.kind, "text");
    if (text.kind === "text") assert.equal(text.text, buffer.toString());
    const docx = new AdmZip();
    docx.addFile("[Content_Types].xml", Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    docx.addFile("word/document.xml", Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p></w:body></w:document>'));
    buffer = docx.toBuffer();
    const document = await previewFile(file("report.docx"));
    assert.equal(document.kind, "document");
    if (document.kind === "document") assert.match(document.html, /Hello Word/);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Budget").addRows([["Item", "Cost"], ["Camera", 42]]);
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const spreadsheet = await previewFile(file("budget.xlsx"));
    assert.equal(spreadsheet.kind, "spreadsheet");
    if (spreadsheet.kind === "spreadsheet") assert.deepEqual(spreadsheet.sheets[0].rows, [["Item", "Cost"], ["Camera", "42"]]);
    buffer = docx.toBuffer();
    reads = 0;
    await previewFile(file("source.zip"));
    assert.ok((await archiveEntry(file("source.zip"), "word/document.xml")).data.length > 0);
    assert.equal(reads, 1, "archive entries reuse the already loaded archive");
    await assert.rejects(archiveEntry(file("source.zip"), "../outside"), /not found/);
  } finally { s3Client.send = original; }
});
