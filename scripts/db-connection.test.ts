import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseConnection } from "../src/lib/db/connection";

test("configured session pool URLs are preserved with a single connection", () => {
  const source = "postgresql://postgres.project:encoded%40password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require";
  const result = databaseConnection(source);
  assert.equal(result.url, source);
  assert.equal(result.options.prepare, true);
  assert.equal(result.options.max, 1);
});

test("existing transaction pool URLs remain unchanged", () => {
  const source = "postgresql://postgres.project:password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
  assert.equal(databaseConnection(source).url, source);
  assert.equal(databaseConnection(source).options.prepare, false);
});

test("direct and other database endpoints keep their supplied ports", () => {
  for (const host of ["localhost", "db.project.supabase.co", "database.example.com"]) {
    const source = `postgresql://postgres:password@${host}:5432/postgres`;
    const result = databaseConnection(source);
    assert.equal(result.url, source);
    assert.equal(result.options.prepare, true);
  }
});
