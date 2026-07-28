import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL environment variable");
}

// Lightweight, connection-pooled Postgres client used for all app-side
// queries (see src/lib/db/queries.ts). Kept separate from the Supabase
// client (src/lib/db/supabase.ts), which is scaffolded for future
// Supabase-specific features (Storage, Realtime, etc.).
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

export const sql = globalForDb.sql ?? postgres(databaseUrl, { max: 4 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.sql = sql;
}
