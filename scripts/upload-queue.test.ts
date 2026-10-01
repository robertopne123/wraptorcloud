import assert from "node:assert/strict";
import { test } from "node:test";
import { UploadQueue, putChunk } from "../src/lib/uploads/queue";
import { uploadPartSize, type UploadJob } from "../src/lib/uploads/types";
import type { FileRecord } from "../src/lib/db/types";

type Deps = NonNullable<ConstructorParameters<typeof UploadQueue>[0]>;

function harness() {
  const jobs = new Map<string, UploadJob>();
  const sources = new Map<string, Blob>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let online = true;
  const storage: Deps["storage"] = {
    list: async () => structuredClone([...jobs.values()]),
    source: async (id) => sources.get(id),
    add: async (job, source) => { jobs.set(job.id, structuredClone(job)); sources.set(job.id, source); },
    save: async (job) => { jobs.set(job.id, structuredClone(job)); },
    finish: async (job) => { jobs.set(job.id, structuredClone(job)); sources.delete(job.id); },
    remove: async (id) => { jobs.delete(id); sources.delete(id); },
  };
  const deps: Deps = {
    storage, lock: async (_id, run) => run(), online: () => online, sleep: async () => {},
    put: async (_url, blob, progress) => { progress(blob.size); },
    request: async <T>(path: string, input: unknown): Promise<T> => {
      const body = input as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/files") return { file: { id: body.s3Key, folder_id: body.folderId } as FileRecord } as T;
      if (body.action === "start") return { uploadId: body.uploadId || `session-${body.id}`, parts: [], complete: body.size === 0 } as T;
      if (body.action === "part") return { url: `part-${body.partNumber}` } as T;
      return { complete: true } as T;
    },
  };
  return { jobs, sources, calls, deps, setOnline: (value: boolean) => { online = value; } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Queue did not settle");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function savedJob(patch: Partial<UploadJob> = {}): UploadJob {
  return { id: crypto.randomUUID(), name: "clip.mp4", contentType: "video/mp4", size: 25,
    folderId: "folder-a", folderName: "Folder A", createdAt: Date.now(), status: "uploading",
    progress: 40, partSize: 10, uploadId: "existing-session", ...patch };
}

test("uploads mixed file types and falls back to binary for files without a MIME type", async () => {
  const h = harness();
  const queue = new UploadQueue(h.deps);
  const files = [
    new File(["pdf"], "report.pdf", { type: "application/pdf" }),
    new File(["zip"], "archive.zip", { type: "application/zip" }),
    new File(["audio"], "audio.mp3", { type: "audio/mpeg" }),
    new File(["custom"], "design.custom"),
    new File(["plain"], "README"),
  ];
  await queue.enqueue(files, null, "Vault");
  await until(() => queue.getSnapshot().jobs.every((job) => job.status === "done"));
  const created = h.calls.filter((call) => call.path === "/api/files");
  assert.equal(created.length, files.length);
  for (const file of files) {
    assert.equal(created.find((call) => call.body.displayName === file.name)?.body.contentType,
      file.type || "application/octet-stream");
  }
});

test("empty extracted files finish without uploading multipart chunks", async () => {
  const h = harness();
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File([], ".gitkeep")], "folder", "Folder");
  await until(() => queue.getSnapshot().jobs[0].status === "done");
  assert.equal(h.calls.filter((call) => call.body.action === "part").length, 0);
  assert.equal(h.calls.find((call) => call.path === "/api/files")?.body.sizeBytes, 0);
});

test("folder batches persist each file destination and share duplicate-file choices", async () => {
  const h = harness();
  h.setOnline(false);
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["a"], "one.jpg"), new File(["b"], "two.jpg")], "parent", "Parent", [
    { folderId: "child-a", folderName: "Parent/Photos" },
    { folderId: "child-b", folderName: "Parent/Videos" },
  ]);
  const jobs = [...h.jobs.values()];
  assert.deepEqual(jobs.map((job) => [job.folderId, job.folderName]), [
    ["child-a", "Parent/Photos"], ["child-b", "Parent/Videos"],
  ]);
  assert.ok(jobs[0].batchId);
  assert.equal(jobs[0].batchId, jobs[1].batchId);
  const restored = new UploadQueue(h.deps);
  await restored.start();
  assert.deepEqual(restored.getSnapshot().jobs.map((job) => job.folderId), ["child-a", "child-b"]);
});

test("large batches use at most three workers and keep each destination folder", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  h.deps.put = async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active--;
  };
  const queue = new UploadQueue(h.deps);
  await queue.enqueue(Array.from({ length: 8 }, (_, i) => new File(["a"], `a-${i}.jpg`)), "a", "Folder A");
  await queue.enqueue([new File(["b"], "b.jpg")], "b", "Folder B");
  await until(() => pending.length === 3);
  assert.equal(queue.getSnapshot().jobs.filter((job) => job.status === "queued").length, 6);
  pending.shift()!();
  await until(() => h.calls.filter((call) => call.body.action === "start").length >= 4);
  const folderBJob = queue.getSnapshot().jobs.find((job) => job.folderId === "b")!;
  assert.equal(h.calls.filter((call) => call.body.action === "start")[3].body.id, folderBJob.id,
    "Folder B gets the next free slot instead of waiting behind all of Folder A");
  while (queue.getSnapshot().jobs.some((job) => job.status !== "done")) {
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(maximum, 3);
  const created = h.calls.filter((call) => call.path === "/api/files");
  assert.equal(created.filter((call) => call.body.folderId === "a").length, 8);
  assert.equal(created.filter((call) => call.body.folderId === "b").length, 1);
  assert.equal(h.sources.size, 0);
});

test("refresh restores the saved source and only uploads parts missing from S3", async () => {
  const h = harness();
  const job = savedJob();
  h.jobs.set(job.id, job); h.sources.set(job.id, new Blob(["x".repeat(25)]));
  const original = h.deps.request;
  h.deps.request = async <T>(path: string, body: unknown) => (body as { action?: string }).action === "start"
    ? { uploadId: "existing-session", parts: [1, 2], complete: false } as T : original<T>(path, body);
  const chunks: number[] = [];
  h.deps.put = async (_url, blob) => { chunks.push(blob.size); };
  const restored = new UploadQueue(h.deps);
  await restored.start();
  await until(() => restored.getSnapshot().jobs[0].status === "done");
  assert.deepEqual(chunks, [5]);
  const part = h.calls.find((call) => call.body.action === "part")!;
  assert.equal(part.body.partNumber, 3);
  assert.equal(part.body.uploadId, "existing-session");
  assert.equal(h.calls.find((call) => call.path === "/api/files")!.body.folderId, "folder-a");
});

test("an already completed S3 object is registered without reuploading", async () => {
  const h = harness();
  const job = savedJob();
  h.jobs.set(job.id, job); h.sources.set(job.id, new Blob(["x"]));
  const original = h.deps.request;
  let puts = 0;
  h.deps.put = async () => { puts++; };
  h.deps.request = async <T>(path: string, body: unknown) => (body as { action?: string }).action === "start"
    ? { complete: true } as T : original<T>(path, body);
  const queue = new UploadQueue(h.deps);
  await queue.start(); await until(() => queue.getSnapshot().jobs[0].status === "done");
  assert.equal(puts, 0);
  assert.equal(h.calls.filter((call) => call.path === "/api/files").length, 1);
});

test("transient failures retry automatically; exhausted retries retain the source for manual retry", async () => {
  const h = harness(); let puts = 0; let fail = true;
  h.deps.put = async () => { puts++; if (fail) throw new Error("network interrupted"); };
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["x"], "clip.mp4")], "a", "Folder A");
  await until(() => queue.getSnapshot().jobs[0].status === "failed");
  assert.equal(puts, 4); assert.equal(h.sources.size, 1);
  // Allow the worker's finally handler to release its slot before manual retry.
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  await queue.retry(queue.getSnapshot().jobs[0].id);
  await until(() => queue.getSnapshot().jobs[0].status === "done");
  assert.equal(h.sources.size, 0);
  assert.equal(new Set(h.calls.filter((call) => call.body.action === "part").map((call) => call.body.uploadId)).size, 1);
});

test("offline files remain queued until connectivity returns", async () => {
  const h = harness(); h.setOnline(false);
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["x"], "clip.mp4")], "a", "Folder A");
  assert.equal(queue.getSnapshot().jobs[0].status, "queued"); assert.equal(h.calls.length, 0);
  h.setOnline(true); queue.pump();
  await until(() => queue.getSnapshot().jobs[0].status === "done");
});

test("quota failures are visible and never start an unsaved upload", async () => {
  const h = harness();
  h.deps.storage.add = async () => { throw new DOMException("full", "QuotaExceededError"); };
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["x"], "clip.mp4")], "a", "Folder A");
  assert.match(queue.getSnapshot().error!, /Not enough browser storage/);
  assert.equal(queue.getSnapshot().jobs.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(queue.getSnapshot().saving, 0);
});

test("two tabs serialize the same upload and do not register it twice", async () => {
  const h = harness(); const job = savedJob();
  h.jobs.set(job.id, job); h.sources.set(job.id, new Blob(["x".repeat(25)]));
  let tail = Promise.resolve();
  h.deps.lock = (_id, run) => { const next = tail.then(run); tail = next; return next; };
  const tab1 = new UploadQueue(h.deps); const tab2 = new UploadQueue(h.deps);
  await Promise.all([tab1.start(), tab2.start()]);
  await until(() => tab1.getSnapshot().jobs[0].status === "done" && tab2.getSnapshot().jobs[0].status === "done");
  assert.equal(h.calls.filter((call) => call.path === "/api/files").length, 1);
});

test("large files stay within S3's 10,000 part limit", () => {
  for (const size of [1, 100 * 1024 ** 2, 5 * 1024 ** 4]) {
    const partSize = uploadPartSize(size);
    assert.ok(partSize >= 5 * 1024 ** 2);
    assert.ok(Math.ceil(size / partSize) <= 10000);
  }
});

test("duplicates wait for a choice before sending file bytes; skipping clears the saved source", async () => {
  const h = harness(); const original = h.deps.request;
  h.deps.request = async <T>(path: string, body: unknown) => path === "/api/uploads/conflict"
    ? { file: { id: "existing", s3_key: "old-key" } } as T : original<T>(path, body);
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["x"], "clip.mp4")], "a", "A");
  await until(() => queue.getSnapshot().jobs[0].status === "conflict");
  assert.equal(h.calls.length, 0); assert.equal(h.sources.size, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await queue.resolveConflict(queue.getSnapshot().jobs[0].id, "skip", false);
  assert.equal(queue.getSnapshot().jobs[0].status, "skipped"); assert.equal(h.sources.size, 0);
  await queue.clearCompleted(); assert.equal(queue.getSnapshot().jobs.length, 0); assert.equal(h.jobs.size, 0);
});

for (const action of ["version", "replace"] as const) {
  test(`batch ${action} survives refresh and targets the correct existing file`, async () => {
    const h = harness(); const original = h.deps.request;
    h.deps.request = async <T>(path: string, body: unknown) => {
      if (path === "/api/uploads/conflict") {
        const { name } = body as { name: string };
        return { file: { id: `existing-${name}`, s3_key: `old-${name}` } } as T;
      }
      return original<T>(path, body);
    };
    const queue = new UploadQueue(h.deps);
    await queue.enqueue([new File(["a"], "a.mp4"), new File(["b"], "b.mp4")], "a", "A");
    await until(() => queue.getSnapshot().jobs.every((job) => job.status === "conflict"));
    await new Promise((resolve) => setImmediate(resolve));
    h.setOnline(false); await queue.resolveConflict(queue.getSnapshot().jobs[0].id, action, true);
    const restored = new UploadQueue(h.deps); await restored.start(); h.setOnline(true); restored.pump();
    await until(() => restored.getSnapshot().jobs.every((job) => job.status === "done"));
    const commits = h.calls.filter((call) => call.path === "/api/files"); assert.equal(commits.length, 2);
    for (const commit of commits) {
      assert.equal(commit.body.conflictAction, action);
      assert.equal(commit.body.targetFileId, `existing-${commit.body.displayName}`);
      assert.equal(commit.body.expectedS3Key, `old-${commit.body.displayName}`);
    }
  });
}

test("batch skip does not carry over to a later batch", async () => {
  const h = harness(); const original = h.deps.request;
  h.deps.request = async <T>(path: string, body: unknown) => path === "/api/uploads/conflict"
    ? { file: { id: "existing", s3_key: "old" } } as T : original<T>(path, body);
  const queue = new UploadQueue(h.deps);
  await queue.enqueue([new File(["a"], "a.mp4"), new File(["b"], "b.mp4")], "a", "A");
  await until(() => queue.getSnapshot().jobs.every((job) => job.status === "conflict"));
  await new Promise((resolve) => setImmediate(resolve));
  await queue.resolveConflict(queue.getSnapshot().jobs[0].id, "skip", true);
  assert.ok(queue.getSnapshot().jobs.every((job) => job.status === "skipped"));
  assert.equal(h.sources.size, 0); assert.equal(h.calls.length, 0);
  await queue.enqueue([new File(["c"], "c.mp4")], "a", "A");
  await until(() => queue.getSnapshot().jobs[2].status === "conflict");
});

test("clearing completed uploads preserves unfinished sources", async () => {
  const h = harness(); const done = savedJob({ status: "done", progress: 100 }); const queued = savedJob({ status: "queued" });
  h.jobs.set(done.id, done); h.jobs.set(queued.id, queued); h.sources.set(queued.id, new Blob(["x"])); h.setOnline(false);
  const queue = new UploadQueue(h.deps); await queue.start(); await queue.clearCompleted();
  assert.deepEqual(queue.getSnapshot().jobs.map((job) => job.id), [queued.id]);
  assert.ok(h.sources.has(queued.id)); assert.ok(!h.jobs.has(done.id));
});

test("a stalled transfer is aborted after two minutes without byte progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  class FakeXHR {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    onabort?: () => void;
    open() {}
    send() {}
    abort() { this.onabort?.(); }
  }
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  try {
    const result = putChunk("https://example.test", new Blob(["x"]), () => {});
    const rejection = assert.rejects(result, /stalled/);
    t.mock.timers.tick(120_001);
    await rejection;
  } finally { globalThis.XMLHttpRequest = previous; }
});
