import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TRACKER_STATUSES, type TrackerStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { status?: string; notes?: string | null; deadline?: string | null };
  const existing = await prisma.trackedApplication.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const data: { status?: TrackerStatus; notes?: string | null; deadline?: Date | null; appliedAt?: Date } = {};
  if (body.status !== undefined) {
    if (!TRACKER_STATUSES.includes(body.status as TrackerStatus)) return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    data.status = body.status as TrackerStatus;
    if (data.status !== "SAVED" && !existing.appliedAt) data.appliedAt = new Date();
  }
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null;
  if (body.deadline !== undefined) {
    const d = body.deadline ? new Date(body.deadline) : null;
    data.deadline = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  const item = await prisma.trackedApplication.update({ where: { id }, data });
  return NextResponse.json({ item });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await prisma.trackedApplication.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
