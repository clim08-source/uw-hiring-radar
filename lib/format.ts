// Small display helpers for the client.

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

/** Days until a date; negative when past. */
export function daysUntil(iso: string, now: number = Date.now()): number {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const SOURCE_LABEL: Record<string, string> = {
  WUSA: "WUSA club",
  DESIGN_TEAM: "Design team",
  CUSTOM: "Custom",
};

export const ROLE_LABEL: Record<string, string> = {
  EXEC: "Exec",
  DIRECTOR: "Director",
  SUBTEAM: "Subteam",
  GENERAL: "General",
  VOLUNTEER: "Volunteer",
  OTHER: "Other",
};
