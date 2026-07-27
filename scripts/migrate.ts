import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (check .env.local)");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    console.log(`Applying migration: ${file}`);
    const script = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await sql.unsafe(script);
  }

  await sql.end();
  console.log(`Applied ${files.length} migration(s) successfully.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
