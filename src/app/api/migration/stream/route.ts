import { sql } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type MigrationRun = {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  migrated: number;
  skipped: number;
  failed: number;
  current_file: string | null;
  current_folder: string | null;
  workers: { file: string; folder: string | null; pct: number }[];
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

async function getLatestRun(): Promise<MigrationRun | null> {
  const rows = await sql<MigrationRun[]>`
    select * from migration_runs order by started_at desc limit 1
  `;
  return rows[0] ?? null;
}

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      let lastUpdatedAt = "";

      async function tick() {
        try {
          const run = await getLatestRun();
          if (!run) {
            send({ type: "idle" });
            return;
          }

          // Only push when something changed
          if (run.updated_at === lastUpdatedAt) return;
          lastUpdatedAt = run.updated_at;

          send({ type: "progress", run });
        } catch {
          // DB hiccup — don't crash the stream
        }
      }

      await tick();

      const interval = setInterval(tick, 1000);

      // Clean up when client disconnects
      return () => clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
