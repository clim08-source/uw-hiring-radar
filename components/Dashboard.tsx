"use client";

import { Radar, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BentoTracker } from "@/components/BentoTracker";
import { HiringFeed } from "@/components/HiringFeed";
import { timeAgo } from "@/lib/format";
import type { OpportunityDTO, ScrapeRunDTO, StatsDTO, TrackedDTO, TrackerStatus } from "@/lib/types";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const fetchFeed = (withClosed: boolean) =>
  getJson<{ opportunities: OpportunityDTO[] }>(`/api/opportunities${withClosed ? "?includeClosed=1" : ""}`).then((d) => d.opportunities);
const fetchTracker = () => getJson<{ items: TrackedDTO[] }>("/api/tracker").then((d) => d.items);
const fetchStatus = () => getJson<{ run: ScrapeRunDTO | null; stats: StatsDTO }>("/api/scrape");

export function Dashboard() {
  const [opportunities, setOpportunities] = useState<OpportunityDTO[] | null>(null);
  const [tracked, setTracked] = useState<TrackedDTO[] | null>(null);
  const [run, setRun] = useState<ScrapeRunDTO | null>(null);
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastProgress = useRef("");

  const loadFeed = useCallback(async (withClosed: boolean) => setOpportunities(await fetchFeed(withClosed)), []);
  const loadTracker = useCallback(async () => setTracked(await fetchTracker()), []);
  const loadStatus = useCallback(async () => {
    const data = await fetchStatus();
    setRun(data.run);
    setStats(data.stats);
    return data.run;
  }, []);

  useEffect(() => {
    let stale = false;
    fetchFeed(includeClosed)
      .then((data) => !stale && setOpportunities(data))
      .catch((e: Error) => setError(e.message));
    return () => {
      stale = true;
    };
  }, [includeClosed]);

  useEffect(() => {
    fetchTracker()
      .then(setTracked)
      .catch((e: Error) => setError(e.message));
    fetchStatus()
      .then((data) => {
        setRun(data.run);
        setStats(data.stats);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // While a scan is running, poll its progress and refresh the feed as results land.
  const running = run?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const latest = await loadStatus();
        const progress = `${latest?.status}:${latest?.opportunitiesFound}`;
        if (progress !== lastProgress.current) {
          lastProgress.current = progress;
          await loadFeed(includeClosed);
        }
      } catch {
        // transient; next tick retries
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [running, loadStatus, loadFeed, includeClosed]);

  const startScan = async () => {
    setError(null);
    try {
      await getJson("/api/scrape", jsonInit("POST", {}));
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const track = async (opportunityId: string) => {
    try {
      const { item } = await getJson<{ item: TrackedDTO }>("/api/tracker", jsonInit("POST", { opportunityId }));
      setTracked((prev) => (prev?.some((t) => t.id === item.id) ? prev : [item, ...(prev ?? [])]));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addManual = async (input: { clubName: string; roleTitle: string; targetTerm: string; url: string; deadline: string }) => {
    const { item } = await getJson<{ item: TrackedDTO }>("/api/tracker", jsonInit("POST", input));
    setTracked((prev) => [item, ...(prev ?? [])]);
  };

  const updateTracked = async (id: string, patch: { status?: TrackerStatus; notes?: string | null }) => {
    // Optimistic: move the card now, reconcile with the server's copy after.
    setTracked((prev) => prev?.map((t) => (t.id === id ? { ...t, ...patch } : t)) ?? prev);
    try {
      const { item } = await getJson<{ item: TrackedDTO }>(`/api/tracker/${id}`, jsonInit("PATCH", patch));
      setTracked((prev) => prev?.map((t) => (t.id === id ? item : t)) ?? prev);
    } catch (e) {
      setError((e as Error).message);
      loadTracker().catch(() => {});
    }
  };

  const removeTracked = async (id: string) => {
    setTracked((prev) => prev?.filter((t) => t.id !== id) ?? prev);
    try {
      await getJson(`/api/tracker/${id}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
      loadTracker().catch(() => {});
    }
  };

  const addClub = async (input: { name: string; url: string }) => {
    const res = await getJson<{ opportunitiesFound: number }>("/api/clubs", jsonInit("POST", input));
    await Promise.all([loadFeed(includeClosed), loadStatus()]);
    return res.opportunitiesFound;
  };

  const pct = run && run.clubsTotal > 0 ? Math.round((run.clubsScraped / run.clubsTotal) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 py-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent text-accent-fg">
            <Radar className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">UW Hiring Radar</h1>
            <p className="text-sm text-muted">Club and design team applications at Waterloo</p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {stats && (
            <span className="rounded-full border border-line bg-surface px-3 py-1 font-mono text-xs text-muted">
              now <b className="text-fg">{stats.currentTerm}</b> · next <b className="text-fg">{stats.nextTerm}</b>
            </span>
          )}
          <button
            onClick={startScan}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg transition hover:brightness-95 disabled:cursor-progress disabled:opacity-70"
          >
            <RefreshCw className={`size-4 ${running ? "animate-spin" : ""}`} aria-hidden />
            {running ? "Scanning…" : "Scan clubs now"}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}

      <section aria-label="Scan status" className="mb-8 rounded-2xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
          <Stat label="Clubs & teams" value={stats?.clubs} />
          <Stat label="WUSA clubs" value={stats?.clubsBySource.WUSA ?? (stats ? 0 : undefined)} />
          <Stat label="Design teams" value={stats?.clubsBySource.DESIGN_TEAM ?? (stats ? 0 : undefined)} />
          <Stat label="Instagram bio links" value={stats?.clubsWithBioLinks} />
          <Stat label="With a link-in-bio" value={stats?.clubsWithLinkInBio} />
          <Stat label="With a Notion site" value={stats?.clubsWithNotion} />
          <Stat label="Open applications" value={stats?.openOpportunities} />
          <div className="ml-auto text-right text-xs text-muted">
            {run ? (
              running ? (
                <span>
                  {run.phase} · {run.clubsScraped}/{run.clubsTotal || "…"}
                </span>
              ) : run.status === "FAILED" ? (
                <span className="text-danger">Last scan failed{run.error ? `: ${run.error}` : ""}</span>
              ) : (
                <span>Last scan {timeAgo(run.finishedAt)}</span>
              )
            ) : (
              <span>No scan yet — run one to fill the feed.</span>
            )}
            {stats && (
              <div>
                Instagram bios: {stats.bioSource === "apify" ? "Apify" : stats.bioSource === "serper" ? "Serper search" : "off (using listed websites)"}
                {run?.bioError ? <span className="text-danger"> · {run.bioError}</span> : null}
              </div>
            )}
            {stats && <div>Classifier: {stats.classifier === "keyword" ? "keyword fallback (no API key)" : stats.classifier.replace("llm:", "")}</div>}
          </div>
        </div>
        {running && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent-strong transition-all duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
          </div>
        )}
      </section>

      <HiringFeed
        opportunities={opportunities}
        trackedOpportunityIds={new Set((tracked ?? []).map((t) => t.opportunityId).filter((id): id is string => Boolean(id)))}
        includeClosed={includeClosed}
        onIncludeClosed={setIncludeClosed}
        onTrack={track}
        onAddClub={addClub}
        scanning={running}
      />

      <BentoTracker items={tracked} onAdd={addManual} onUpdate={updateTracked} onRemove={removeTracked} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <div className="font-mono text-xl font-semibold tabular-nums">{value ?? "–"}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
