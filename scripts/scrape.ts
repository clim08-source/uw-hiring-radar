// CLI entry point: `npm run scrape` (full run) or `npm run scrape -- --limit 10`.
import { prisma } from "../lib/db";
import { runPipeline } from "../lib/pipeline";

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limitPerSource = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const skipDiscovery = args.includes("--skip-discovery");

  const run = await prisma.scrapeRun.create({ data: {} });
  const timer = setInterval(async () => {
    const r = await prisma.scrapeRun.findUnique({ where: { id: run.id } });
    if (r) console.log(`[${r.phase}] clubs ${r.clubsScraped}/${r.clubsTotal} · opportunities ${r.opportunitiesFound}`);
  }, 5000);

  await runPipeline(run.id, { limitPerSource, skipDiscovery });
  clearInterval(timer);

  const done = await prisma.scrapeRun.findUnique({ where: { id: run.id } });
  console.log(
    `${done?.status}: discovered ${done?.clubsDiscovered}, scraped ${done?.clubsScraped}, live opportunities ${done?.opportunitiesFound} (classifier: ${done?.classifier})${done?.error ? ` — ${done.error}` : ""}`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
