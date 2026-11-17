import { NextResponse, type NextRequest } from "next/server";
import { dbConfigError, prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Hiring feed. Query: ?includeClosed=1 */
export async function GET(request: NextRequest) {
  const configError = dbConfigError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });
  const includeClosed = request.nextUrl.searchParams.get("includeClosed") === "1";
  const opportunities = await prisma.applicationOpportunity.findMany({
    where: includeClosed ? undefined : { status: { not: "CLOSED" } },
    include: { club: true },
    orderBy: [{ lastVerifiedAt: "desc" }, { confidence: "desc" }],
    take: 500,
  });
  return NextResponse.json({ opportunities });
}
