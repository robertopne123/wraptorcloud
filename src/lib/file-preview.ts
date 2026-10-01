import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { lookup } from "mime-types";
import type { FileRecord } from "./db/types";
import { getObjectBuffer, presignFileViewUrl, presignKeyUrl } from "./s3";
import { previewKind, type PreviewData } from "./preview-types";
import { readArchive, MAX_ARCHIVE_BYTES, type ArchiveContent } from "./archive";
import { generateWaveform } from "./audio-waveform";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_LENGTH = 200_000;
let cachedArchive: { key: string; expires: number; entries: Promise<ArchiveContent[]> } | undefined;

async function loadArchive(file: FileRecord) {
  if (Number(file.size_bytes) > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 100 MB preview limit");
  if (cachedArchive?.key === file.s3_key && cachedArchive.expires > Date.now()) return cachedArchive.entries;
  const entries = getObjectBuffer(file.s3_key, MAX_ARCHIVE_BYTES).then((buffer) => readArchive(buffer, file.display_name));
  // Keep only one archive in memory; extraction requests reuse its entry index.
  cachedArchive = { key: file.s3_key, expires: Date.now() + 60_000, entries };
  try { return await entries; }
  catch (error) { if (cachedArchive?.entries === entries) cachedArchive = undefined; throw error; }
}

export async function previewFile(file: FileRecord): Promise<PreviewData> {
  const kind = previewKind(file.display_name, file.mime_type);
  if (kind === "unsupported") return { kind };
  if (kind === "pdf") return { kind, url: await presignFileViewUrl(file, { attachment: false, contentType: "application/pdf" }) };
  if (kind === "audio") {
    const url = await presignKeyUrl(file.s3_key);
    try { return { kind, url, ...await generateWaveform(file.s3_key, url) }; }
    catch { return { kind, url, duration: 0, peaks: [], waveformError: "The waveform could not be generated. You can still use the player controls." }; }
  }
  if (kind === "archive") {
    return { kind, entries: (await loadArchive(file)).map(({ path, size, directory }) => ({ path, size, directory })) };
  }
  const limit = MAX_DOCUMENT_BYTES;
  if (Number(file.size_bytes) > limit) throw new Error(`File exceeds the ${limit / 1024 / 1024} MB preview limit`);
  const buffer = await getObjectBuffer(file.s3_key, limit);
  if (kind === "document") {
    // Check ZIP expansion limits before handing Office files to their parsers.
    await readArchive(buffer, "document.zip");
    const { value } = await mammoth.convertToHtml({ buffer });
    return { kind, html: value.slice(0, 2_000_000), truncated: value.length > 2_000_000 };
  }
  if (kind === "spreadsheet") {
    await readArchive(buffer, "spreadsheet.zip");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    return { kind, sheets: workbook.worksheets.slice(0, 20).map((sheet) => {
      const rows: string[][] = [];
      for (let row = 1; row <= Math.min(sheet.rowCount, 500); row++) {
        const cells: string[] = [];
        for (let column = 1; column <= Math.min(sheet.columnCount, 50); column++) {
          cells.push(sheet.getCell(row, column).text.slice(0, 2000));
        }
        rows.push(cells);
      }
      return { name: sheet.name, rows, truncated: sheet.rowCount > 500 || sheet.columnCount > 50 };
    }) };
  }
  const text = buffer.toString("utf8");
  return { kind: "text", text: text.slice(0, MAX_TEXT_LENGTH), truncated: text.length > MAX_TEXT_LENGTH };
}

export async function archiveEntry(file: FileRecord, path: string) {
  if (previewKind(file.display_name, file.mime_type) !== "archive") throw new Error("This file is not a supported archive");
  const entry = (await loadArchive(file)).find((entry) => entry.path === path && !entry.directory);
  if (!entry) throw new Error("Archive entry not found");
  return { data: entry.read(), contentType: lookup(entry.path) || "application/octet-stream" };
}
