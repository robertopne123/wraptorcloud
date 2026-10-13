import postgres from "postgres";
import { databaseConnection } from "./connection";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL environment variable");
}

// Lightweight, connection-pooled Postgres client used for all app-side
// queries (see src/lib/db/queries.ts). Kept separate from the Supabase
// client (src/lib/db/supabase.ts), which is scaffolded for future
// Supabase-specific features (Storage, Realtime, etc.).
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

const connection = databaseConnection(databaseUrl);
export const sql = globalForDb.sql ?? postgres(connection.url, connection.options);

// Reuse the pool in every environment. Separate server bundles can evaluate
// this module more than once within the same process in production too.
globalForDb.sql = sql;
