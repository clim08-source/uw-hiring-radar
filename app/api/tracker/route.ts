import { NextResponse } from "next/server";
import { dbConfigError, prisma } from "@/lib/db";
import { TRACKER_STATUSES, type TrackerStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const configError = dbConfigError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });
  const items = await prisma.trackedApplication.findMany({ orderBy: { updatedAt: "desc" } });
  return NextResponse.json({ items });
}

/** Track an opportunity from the feed ({ opportunityId }) or a manual entry ({ clubName, roleTitle, ... }). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    opportunityId?: string;
    clubName?: string;
    roleTitle?: string;
    targetTerm?: string;
    url?: string;
    status?: string;
    notes?: string;
    deadline?: string;
  };
  const status: TrackerStatus = TRACKER_STATUSES.includes(body.status as TrackerStatus) ? (body.status as TrackerStatus) : "SAVED";

  if (body.opportunityId) {
    const existing = await prisma.trackedApplication.findFirst({ where: { opportunityId: body.opportunityId } });
    if (existing) return NextResponse.json({ item: existing });
    const opp = await prisma.applicationOpportunity.findUnique({ where: { id: body.opportunityId }, include: { club: true } });
    if (!opp) return NextResponse.json({ error: "Opportunity not found." }, { status: 404 });
    const item = await prisma.trackedApplication.create({
      data: {
        opportunityId: opp.id,
        clubName: opp.club.name,
        roleTitle: opp.title,
        targetTerm: opp.targetTerm,
        url: opp.url,
        deadline: opp.deadline,
        status,
        appliedAt: status === "APPLIED" ? new Date() : null,
      },
    });
    return NextResponse.json({ item }, { status: 201 });
  }

  const clubName = body.clubName?.trim();
  const roleTitle = body.roleTitle?.trim();
  if (!clubName || !roleTitle) return NextResponse.json({ error: "clubName and roleTitle are required." }, { status: 400 });
  const deadline = body.deadline ? new Date(body.deadline) : null;
  const item = await prisma.trackedApplication.create({
    data: {
      clubName,
      roleTitle,
      targetTerm: body.targetTerm?.trim() || null,
      url: body.url?.trim() || null,
      notes: body.notes?.trim() || null,
      deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
      status,
      appliedAt: status === "APPLIED" ? new Date() : null,
    },
  });
  return NextResponse.json({ item }, { status: 201 });
}
