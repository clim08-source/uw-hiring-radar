"use client";

import { CalendarClock, ExternalLink, GripVertical, NotebookPen, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { daysUntil, shortDate } from "@/lib/format";
import { TRACKER_STATUSES, type TrackedDTO, type TrackerStatus } from "@/lib/types";

interface Props {
  items: TrackedDTO[] | null;
  onAdd: (input: { clubName: string; roleTitle: string; targetTerm: string; url: string; deadline: string }) => Promise<void>;
  onUpdate: (id: string, patch: { status?: TrackerStatus; notes?: string | null }) => void;
  onRemove: (id: string) => void;
}

const STAGES: Record<TrackerStatus, { label: string; hint: string; dot: string; span: string }> = {
  SAVED: { label: "Saved", hint: "Bookmark from the feed, or drop a card here", dot: "bg-muted", span: "md:col-span-3 lg:col-span-4 lg:row-span-2" },
  APPLIED: { label: "Applied", hint: "Submitted and waiting", dot: "bg-accent-strong", span: "md:col-span-3 lg:col-span-4 lg:row-span-2" },
  INTERVIEW: { label: "Interview", hint: "Coffee chats and interviews", dot: "bg-sky-500", span: "md:col-span-6 lg:col-span-4" },
  OFFER: { label: "Offer", hint: "You got in", dot: "bg-ok", span: "md:col-span-3 lg:col-span-2" },
  REJECTED: { label: "Not this term", hint: "Try again next term", dot: "bg-off", span: "md:col-span-3 lg:col-span-2" },
};

const tile = "rounded-2xl border border-line bg-surface p-4";

export function BentoTracker({ items, onAdd, onUpdate, onRemove }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<TrackerStatus | null>(null);

  const byStage = useMemo(() => {
    const map = Object.fromEntries(TRACKER_STATUSES.map((s) => [s, [] as TrackedDTO[]])) as Record<TrackerStatus, TrackedDTO[]>;
    for (const item of items ?? []) (map[item.status] ?? map.SAVED).push(item);
    return map;
  }, [items]);

  const total = items?.length ?? 0;
  const upcoming = useMemo(
    () =>
      (items ?? [])
        .filter((i) => i.deadline && (i.status === "SAVED" || i.status === "APPLIED") && daysUntil(i.deadline) >= 0)
        .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())
        .slice(0, 4),
    [items],
  );

  const drop = (stage: TrackerStatus) => {
    const item = items?.find((i) => i.id === dragId);
    if (item && item.status !== stage) onUpdate(item.id, { status: stage });
    setDragId(null);
    setOverStage(null);
  };

  return (
    <section aria-labelledby="tracker-heading">
      <div className="mb-4">
        <h2 id="tracker-heading" className="text-xl font-semibold tracking-tight">
          Application tracker
        </h2>
        <p className="text-sm text-muted">Drag cards between tiles, or use the stage menu on each card. Saved to the app&apos;s database.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-6 lg:grid-cols-12 lg:auto-rows-[minmax(11rem,auto)]">
        {/* Pipeline summary */}
        <div className={`${tile} md:col-span-6 lg:col-span-5`}>
          <h3 className="text-sm font-medium text-muted">Pipeline</h3>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tabular-nums">{items === null ? "–" : total}</span>
            <span className="text-sm text-muted">tracked application{total === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            {total > 0 &&
              TRACKER_STATUSES.map((s) =>
                byStage[s].length > 0 ? <div key={s} className={STAGES[s].dot} style={{ width: `${(byStage[s].length / total) * 100}%` }} /> : null,
              )}
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {TRACKER_STATUSES.map((s) => (
              <div key={s} className="flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${STAGES[s].dot}`} aria-hidden />
                <dt className="text-muted">{STAGES[s].label}</dt>
                <dd className="font-mono font-semibold tabular-nums">{byStage[s].length}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Upcoming deadlines */}
        <div className={`${tile} md:col-span-3 lg:col-span-3`}>
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted">
            <CalendarClock className="size-4" aria-hidden /> Next deadlines
          </h3>
          {upcoming.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No upcoming deadlines on saved or applied cards.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {upcoming.map((i) => {
                const d = daysUntil(i.deadline!);
                return (
                  <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{i.clubName}</span>
                    <span className={`shrink-0 font-mono text-xs ${d <= 3 ? "text-danger" : "text-muted"}`}>{d === 0 ? "today" : `${d}d`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Quick add */}
        <QuickAdd onAdd={onAdd} />

        {/* Stage tiles double as drop zones */}
        {TRACKER_STATUSES.map((stage) => {
          const cards = byStage[stage];
          const active = overStage === stage && dragId !== null;
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overStage !== stage) setOverStage(stage);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(stage);
              }}
              className={`${tile} ${STAGES[stage].span} flex flex-col transition ${active ? "border-accent-strong ring-2 ring-accent/50" : ""}`}
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <span className={`size-2.5 rounded-full ${STAGES[stage].dot}`} aria-hidden />
                  {STAGES[stage].label}
                </h3>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-xs tabular-nums text-muted">{cards.length}</span>
              </div>
              {cards.length === 0 ? (
                <p className="grid flex-1 place-items-center rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
                  {STAGES[stage].hint}
                </p>
              ) : (
                <ul className={`grid gap-2 ${stage === "INTERVIEW" ? "sm:grid-cols-2 lg:grid-cols-1" : ""}`}>
                  {cards.map((item) => (
                    <TrackerCard
                      key={item.id}
                      item={item}
                      dragging={dragId === item.id}
                      onDragStart={() => setDragId(item.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverStage(null);
                      }}
                      onUpdate={onUpdate}
                      onRemove={onRemove}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TrackerCard({
  item,
  dragging,
  onDragStart,
  onDragEnd,
  onUpdate,
  onRemove,
}: {
  item: TrackedDTO;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onUpdate: Props["onUpdate"];
  onRemove: Props["onRemove"];
}) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? "");
  const days = item.deadline ? daysUntil(item.deadline) : null;

  const saveNotes = () => {
    setEditing(false);
    if ((item.notes ?? "") !== notes.trim()) onUpdate(item.id, { notes: notes.trim() || null });
  };

  return (
    <li
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`group rounded-xl border border-line bg-bg p-3 ${dragging ? "opacity-40" : ""} ${editing ? "" : "cursor-grab active:cursor-grabbing"}`}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="mt-0.5 size-4 shrink-0 text-muted/60" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{item.clubName}</div>
          <div className="truncate text-xs text-muted">{item.roleTitle}</div>
        </div>
        {item.targetTerm && <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-fg">{item.targetTerm}</span>}
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
          }}
          rows={3}
          placeholder="Notes — who you talked to, interview time, what to prep…"
          aria-label={`Notes for ${item.clubName}`}
          className="mt-2 w-full resize-y rounded-lg border border-line bg-surface p-2 text-xs placeholder:text-muted"
        />
      ) : (
        item.notes && (
          <button onClick={() => setEditing(true)} className="mt-2 block w-full whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-left text-xs text-muted hover:text-fg">
            {item.notes}
          </button>
        )
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`stage-${item.id}`}>
          Stage for {item.clubName}
        </label>
        <select
          id={`stage-${item.id}`}
          value={item.status}
          onChange={(e) => onUpdate(item.id, { status: e.target.value as TrackerStatus })}
          className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
        >
          {TRACKER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STAGES[s].label}
            </option>
          ))}
        </select>
        {item.deadline && days !== null && (
          <span className={`inline-flex items-center gap-1 text-xs ${days >= 0 && days <= 3 ? "text-danger" : "text-muted"}`}>
            <CalendarClock className="size-3" aria-hidden />
            {shortDate(item.deadline)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={() => setEditing(true)} aria-label={`Edit notes for ${item.clubName}`} title="Notes" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <NotebookPen className="size-3.5" aria-hidden />
          </button>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open application for ${item.clubName}`} title="Open application" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          <button onClick={() => onRemove(item.id)} aria-label={`Remove ${item.clubName} from tracker`} title="Remove" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger">
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}

function QuickAdd({ onAdd }: { onAdd: Props["onAdd"] }) {
  const empty = { clubName: "", roleTitle: "", targetTerm: "", url: "", deadline: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onAdd(form);
      setForm(empty);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm placeholder:text-muted";
  return (
    <form onSubmit={submit} className={`${tile} md:col-span-3 lg:col-span-4`}>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
        <Plus className="size-4" aria-hidden /> Add your own
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <input required value={form.clubName} onChange={set("clubName")} placeholder="Club or team" aria-label="Club or team" className={field} />
        <input required value={form.roleTitle} onChange={set("roleTitle")} placeholder="Role" aria-label="Role" className={field} />
        <input value={form.targetTerm} onChange={set("targetTerm")} placeholder="Term (W27)" aria-label="Term" maxLength={3} className={`${field} font-mono`} />
        <input type="date" value={form.deadline} onChange={set("deadline")} aria-label="Deadline" className={field} />
        <input value={form.url} onChange={set("url")} placeholder="Application link (optional)" aria-label="Application link" className={`${field} col-span-2`} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button disabled={busy} className="rounded-lg bg-fg px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-60">
          {busy ? "Adding…" : "Add to Saved"}
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </form>
  );
}
