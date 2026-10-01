import assert from "node:assert/strict";
import { test } from "node:test";
import { ZipDownload } from "../src/lib/zip-download";

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Download did not reach expected state");
}

test("ZIP byte progress is visible before the archive finishes", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const saved: Blob[] = [];
  const download = new ZipDownload({ now: () => Date.now(),
    fetch: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
      headers: { "X-Archive-File-Count": "3", "X-Archive-Filename": "test.zip" },
    }), save: (blob, filename) => { assert.equal(filename, "test.zip"); saved.push(blob); },
  });
  const task = download.start([], ["folder"]);
  await until(() => download.getSnapshot().status === "receiving");
  stream.enqueue(new Uint8Array([1, 2, 3]));
  await until(() => download.getSnapshot().bytes === 3);
  assert.equal(download.getSnapshot().status, "receiving");
  download.dismiss(); assert.equal(download.getSnapshot().status, "receiving");
  assert.equal(download.getSnapshot().fileCount, 3); assert.equal(saved.length, 0);
  stream.enqueue(new Uint8Array([4, 5])); stream.close(); await task;
  assert.equal(download.getSnapshot().bytes, 5); assert.equal(download.getSnapshot().status, "done");
  assert.deepEqual([...new Uint8Array(await saved[0].arrayBuffer())], [1, 2, 3, 4, 5]);
  download.dismiss(); assert.equal(download.getSnapshot().status, "idle"); assert.equal(download.getSnapshot().bytes, 0);
});

test("ZIP cancellation stops the reader and never downloads an incomplete archive", async () => {
  let cancelled = false; let saved = false;
  const download = new ZipDownload({ now: () => Date.now(),
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    save: () => { saved = true; },
  });
  const task = download.start(["file"], []);
  await until(() => download.getSnapshot().status === "receiving");
  download.cancel(); await task;
  assert.equal(download.getSnapshot().status, "cancelled"); assert.ok(cancelled); assert.ok(!saved);
});

test("ZIP stream failures are shown instead of saving a partial archive", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>; let saved = false;
  const download = new ZipDownload({ now: () => Date.now(),
    fetch: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })),
    save: () => { saved = true; },
  });
  const task = download.start(["file"], []);
  await until(() => download.getSnapshot().status === "receiving");
  stream.error(new Error("Connection lost")); await task;
  assert.equal(download.getSnapshot().status, "failed"); assert.match(download.getSnapshot().error!, /Connection lost/);
  assert.ok(!saved);
});
