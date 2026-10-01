import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import postgres from "postgres";

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync("migrations/0009_file_notes.sql", "utf8"));
    });
    console.log("Applied file notes migration.");
  } finally { await sql.end({ timeout: 2 }); }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
