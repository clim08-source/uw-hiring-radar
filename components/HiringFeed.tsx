"use client";

import { AtSign, Bookmark, BookmarkCheck, CalendarClock, CircleCheck, CircleDashed, CircleX, ExternalLink, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { daysUntil, hostLabel, isMembership, ROLE_LABEL, shortDate, SOURCE_LABEL, timeAgo } from "@/lib/format";
import type { OpportunityDTO } from "@/lib/types";

interface Props {
  opportunities: OpportunityDTO[] | null;
  trackedOpportunityIds: Set<string>;
  includeClosed: boolean;
  onIncludeClosed: (value: boolean) => void;
  onTrack: (opportunityId: string) => void;
  onAddClub: (input: { name: string; url: string }) => Promise<number>;
  scanning: boolean;
}

const SOURCES = [
  { key: "ALL", label: "All" },
  { key: "WUSA", label: "Clubs" },
  { key: "DESIGN_TEAM", label: "Design teams" },
  { key: "CUSTOM", label: "Custom" },
];

const KINDS = [
  { key: "ALL", label: "All types", hint: "Everything" },
  { key: "ROLES", label: "Exec & team roles", hint: "Exec, director, subteam, volunteer and other applications you are selected for" },
  { key: "MEMBER", label: "General membership", hint: "Open membership sign-ups and interest forms" },
];

const PREVIEW_COUNT = 9;

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs font-medium transition ${
    active ? "border-fg bg-fg text-bg" : "border-line bg-surface text-muted hover:text-fg"
  }`;

export function HiringFeed({ opportunities, trackedOpportunityIds, includeClosed, onIncludeClosed, onTrack, onAddClub, scanning }: Props) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("ALL");
  const [term, setTerm] = useState("ALL");
  const [kind, setKind] = useState("ALL");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const terms = useMemo(() => {
    const set = new Set<string>();
    for (const o of opportunities ?? []) if (o.targetTerm) set.add(o.targetTerm);
    return [...set].sort();
  }, [opportunities]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (opportunities ?? []).filter((o) => {
      if (source !== "ALL" && o.club.source !== source) return false;
      if (term === "NONE" ? o.targetTerm !== null : term !== "ALL" && o.targetTerm !== term) return false;
      if (kind === "ROLES" && isMembership(o.roleType)) return false;
      if (kind === "MEMBER" && !isMembership(o.roleType)) return false;
      if (verifiedOnly && o.status !== "OPEN") return false;
      if (q && !`${o.title} ${o.club.name} ${o.club.category ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [opportunities, query, source, term, kind, verifiedOnly]);

  const kindCounts = useMemo(() => {
    const member = (opportunities ?? []).filter((o) => isMembership(o.roleType)).length;
    return { ROLES: (opportunities?.length ?? 0) - member, MEMBER: member };
  }, [opportunities]);

  return (
    <section aria-labelledby="feed-heading" className="mb-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="feed-heading" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="relative flex size-2.5">
              <span className={`absolute inline-flex size-full rounded-full bg-ok opacity-60 ${scanning ? "animate-ping" : ""}`} />
              <span className="relative inline-flex size-2.5 rounded-full bg-ok" />
            </span>
            Live hiring feed
          </h2>
          <p className="text-sm text-muted">
            {opportunities === null ? "Loading…" : `${filtered.length} of ${opportunities.length} applications`}
          </p>
        </div>
        <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm hover:bg-surface-2">
          <Plus className="size-4" aria-hidden /> Add a club
        </button>
      </div>

      {adding && <AddClubForm onAddClub={onAddClub} onDone={() => setAdding(false)} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-52 sm:max-w-xs">
          <span className="sr-only">Search applications</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clubs or roles"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm placeholder:text-muted"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Source">
          {SOURCES.map((s) => (
            <button key={s.key} onClick={() => setSource(s.key)} aria-pressed={source === s.key} className={chip(source === s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="hidden h-5 w-px bg-line sm:block" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Application type">
          {KINDS.map((k) => (
            <button key={k.key} onClick={() => setKind(k.key)} aria-pressed={kind === k.key} title={k.hint} className={chip(kind === k.key)}>
              {k.label}
              {k.key !== "ALL" && opportunities !== null && <span className="ml-1.5 font-mono opacity-70">{kindCounts[k.key as "ROLES" | "MEMBER"]}</span>}
            </button>
          ))}
        </div>
        <span className="hidden h-5 w-px bg-line sm:block" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Term">
          <button onClick={() => setTerm("ALL")} aria-pressed={term === "ALL"} className={chip(term === "ALL")}>
            Any term
          </button>
          {terms.map((t) => (
            <button key={t} onClick={() => setTerm(t)} aria-pressed={term === t} className={`${chip(term === t)} font-mono`}>
              {t}
            </button>
          ))}
          <button onClick={() => setTerm("NONE")} aria-pressed={term === "NONE"} className={chip(term === "NONE")}>
            No term named
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} className="accent-(--accent-strong)" />
            Verified open only
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={includeClosed} onChange={(e) => onIncludeClosed(e.target.checked)} className="accent-(--accent-strong)" />
            Show closed
          </label>
        </div>
      </div>

      {opportunities === null ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl border border-line bg-surface" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center text-sm text-muted">
          {opportunities.length === 0
            ? scanning
              ? "Scanning clubs — applications will appear here as they are found."
              : "No applications yet. Use “Scan clubs now” to discover clubs and check their link-in-bio pages."
            : "Nothing matches these filters."}
        </div>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(expanded ? filtered : filtered.slice(0, PREVIEW_COUNT)).map((o) => (
              <OpportunityCard key={o.id} o={o} tracked={trackedOpportunityIds.has(o.id)} onTrack={onTrack} />
            ))}
          </ul>
          {filtered.length > PREVIEW_COUNT && (
            <div className="mt-4 text-center">
              <button onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm hover:bg-surface-2">
                {expanded ? "Show fewer" : `Show all ${filtered.length} applications`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "OPEN") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-xs font-medium text-ok" title="The form was fetched and is accepting responses">
        <CircleCheck className="size-3.5" aria-hidden /> Open
      </span>
    );
  }
  if (status === "CLOSED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-off-bg px-2 py-0.5 text-xs font-medium text-off">
        <CircleX className="size-3.5" aria-hidden /> Closed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn" title="Listed on the club's page, but the form's state could not be confirmed">
      <CircleDashed className="size-3.5" aria-hidden /> Unverified
    </span>
  );
}

function OpportunityCard({ o, tracked, onTrack }: { o: OpportunityDTO; tracked: boolean; onTrack: (id: string) => void }) {
  const closed = o.status === "CLOSED";
  const days = o.deadline ? daysUntil(o.deadline) : null;
  return (
    <li className={`flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 ${closed ? "opacity-60" : ""}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted">
          {SOURCE_LABEL[o.club.source] ?? o.club.source}
          {o.club.category && o.club.source === "WUSA" ? ` · ${o.club.category.split(",")[0]}` : ""}
        </span>
        <StatusBadge status={o.status} />
      </div>

      <h3 className="break-words text-sm font-semibold leading-snug">{o.club.name}</h3>
      <p className="mt-0.5 line-clamp-2 break-words text-sm text-muted" title={o.reason ?? undefined}>
        {o.title}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        {o.targetTerm && <span className="rounded-md bg-accent px-1.5 py-0.5 font-mono font-semibold text-accent-fg">{o.targetTerm}</span>}
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-muted">{ROLE_LABEL[o.roleType] ?? o.roleType}</span>
        {o.deadline && days !== null && (
          <span className={`inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 ${days >= 0 && days <= 5 ? "text-danger" : "text-muted"}`}>
            <CalendarClock className="size-3" aria-hidden />
            {days < 0 ? `was due ${shortDate(o.deadline)}` : `due ${shortDate(o.deadline)}`}
          </span>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <div className="min-w-0 text-xs text-muted">
          <div className="truncate">{hostLabel(o.url)}</div>
          <div className="flex items-center gap-2">
            <span>checked {timeAgo(o.lastVerifiedAt)}</span>
            {o.club.instagramHandle && (
              <a href={`https://www.instagram.com/${o.club.instagramHandle}`} target="_blank" rel="noreferrer" className="inline-flex items-center hover:text-fg" title={`@${o.club.instagramHandle} on Instagram`}>
                <AtSign className="size-3" aria-hidden />
                <span className="max-w-24 truncate">{o.club.instagramHandle}</span>
              </a>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onTrack(o.id)}
            disabled={tracked}
            aria-label={tracked ? "Already in your tracker" : `Track ${o.title} at ${o.club.name}`}
            title={tracked ? "In your tracker" : "Add to tracker"}
            className="grid size-8 place-items-center rounded-lg border border-line hover:bg-surface-2 disabled:text-accent-strong"
          >
            {tracked ? <BookmarkCheck className="size-4" aria-hidden /> : <Bookmark className="size-4" aria-hidden />}
          </button>
          <a
            href={o.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fg px-3 text-xs font-medium text-bg hover:opacity-90"
          >
            {closed ? "View" : "Apply"} <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      </div>
    </li>
  );
}

function AddClubForm({ onAddClub, onDone }: { onAddClub: Props["onAddClub"]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const found = await onAddClub({ name, url });
      setMessage(found > 0 ? `Added — found ${found} application${found === 1 ? "" : "s"}.` : "Added — no open applications on that page right now.");
      setName("");
      setUrl("");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "rounded-lg border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted";
  return (
    <form onSubmit={submit} className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3">
      <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Club name" aria-label="Club name" className={`${field} min-w-0 flex-1 basis-40`} />
      <input
        required
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="linktr.ee/yourclub or website"
        aria-label="Link-in-bio or website URL"
        className={`${field} min-w-0 flex-[2] basis-56`}
      />
      <button disabled={busy} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-60">
        {busy ? "Checking…" : "Add & scan"}
      </button>
      <button type="button" onClick={onDone} className="rounded-lg px-2 py-2 text-sm text-muted hover:text-fg">
        Close
      </button>
      {message && <p className="w-full text-xs text-muted">{message}</p>}
    </form>
  );
}
