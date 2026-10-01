export type PreviewKind = "pdf" | "document" | "spreadsheet" | "text" | "audio" | "archive" | "unsupported";

export function previewKind(name: string, mime: string): PreviewKind {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const type = mime.toLowerCase().split(";")[0].trim();
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("audio/") || /^(mp3|wav|flac|m4a|aac|ogg|opus|aiff|aif|wma)$/.test(extension)) return "audio";
  if (/^(zip|tar|tgz|gz)$/.test(extension) || ["application/zip", "application/x-tar", "application/gzip", "application/x-gzip"].includes(type)) return "archive";
  if (extension === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "document";
  if (extension === "xlsx" || type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "spreadsheet";
  if (type.startsWith("text/") || /^(txt|md|csv|tsv|json|xml|yaml|yml|log|js|jsx|ts|tsx|css|html|py|sql|sh|ini|toml)$/.test(extension)
    || ["application/json", "application/xml"].includes(type)) return "text";
  return "unsupported";
}

export type ArchiveItem = { path: string; size: number; directory: boolean };
export type PreviewData =
  | { kind: "pdf"; url: string }
  | { kind: "document"; html: string; truncated: boolean }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "spreadsheet"; sheets: { name: string; rows: string[][]; truncated: boolean }[] }
  | { kind: "audio"; url: string; duration: number; peaks: number[]; waveformError?: string }
  | { kind: "archive"; entries: ArchiveItem[] }
  | { kind: "unsupported" };
