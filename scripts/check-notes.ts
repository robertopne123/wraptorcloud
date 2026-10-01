import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

async function main() {
  const { GET, PUT } = await import("../src/app/api/files/[id]/notes/route");
  const { sql } = await import("../src/lib/db/client");
  const id = randomUUID();
  const context = { params: Promise.resolve({ id }) };
  const request = (notes: unknown) => new Request(`http://localhost/api/files/${id}/notes`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }),
  });
  try {
    assert.equal((await PUT(request(123), context)).status, 400);
    assert.equal((await PUT(request("x".repeat(10001)), context)).status, 400);
    assert.equal((await GET(new Request("http://localhost"), context)).status, 404);
    await sql`insert into files (id, display_name, s3_key, mime_type, media_type, size_bytes)
      values (${id}, 'Notes smoke test', ${`test-notes/${id}`}, 'image/png', 'image', 1)`;
    assert.deepEqual(await (await GET(new Request("http://localhost"), context)).json(), { notes: "" });
    const notes = "First line\nSecond line — test";
    assert.equal((await PUT(request(notes), context)).status, 200);
    assert.deepEqual(await (await GET(new Request("http://localhost"), context)).json(), { notes });
    assert.equal((await PUT(request(""), context)).status, 200);
    assert.deepEqual(await (await GET(new Request("http://localhost"), context)).json(), { notes: "" });
    await sql`update files set media_type = 'video', mime_type = 'video/mp4' where id = ${id}`;
    assert.equal((await PUT(request(notes), context)).status, 200);
    await sql`update files set media_type = 'other' where id = ${id}`;
    assert.equal((await PUT(request(notes), context)).status, 404);
    await sql`update files set media_type = 'image', deleted_at = now() where id = ${id}`;
    assert.equal((await GET(new Request("http://localhost"), context)).status, 404);
    console.log("Notes checks passed: validation, image/video saving, clearing, persistence, unsupported/deleted files.");
  } finally {
    await sql`delete from files where id = ${id}`;
    await sql.end({ timeout: 2 });
  }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
