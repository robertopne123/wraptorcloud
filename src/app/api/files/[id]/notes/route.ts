import { NextResponse } from "next/server";
import { getFile } from "@/lib/db/queries";
import { sql } from "@/lib/db/client";

type Context = { params: Promise<{ id: string }> };

async function mediaFile(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const file = await getFile(id);
  return file && file.media_type !== "other" ? file : null;
}

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  if (!await mediaFile(id)) return NextResponse.json({ error: "Image or video not found" }, { status: 404 });
  const rows = await sql<{ notes: string }[]>`select notes from file_notes where file_id = ${id}`;
  return NextResponse.json({ notes: rows[0]?.notes ?? "" });
}

export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.notes !== "string" || body.notes.length > 10000) {
    return NextResponse.json({ error: "Notes must be text of at most 10,000 characters" }, { status: 400 });
  }
  if (!await mediaFile(id)) return NextResponse.json({ error: "Image or video not found" }, { status: 404 });
  await sql`
    insert into file_notes (file_id, notes) values (${id}, ${body.notes})
    on conflict (file_id) do update set notes = excluded.notes, updated_at = now()
  `;
  return NextResponse.json({ notes: body.notes });
}
