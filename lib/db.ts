import { PrismaClient } from "@prisma/client";

// Reuse one client across hot reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** A human-readable reason the database cannot work in this environment, or null. */
export function dbConfigError(): string | null {
  const hasPostgres = ["DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL"].some((name) => /^postgres(ql)?:\/\//.test(process.env[name] ?? ""));
  if (process.env.VERCEL && !hasPostgres) {
    return "No database is configured. This app needs Postgres when hosted on Vercel: add a Neon database under Storage in your Vercel project, then redeploy.";
  }
  return null;
}
