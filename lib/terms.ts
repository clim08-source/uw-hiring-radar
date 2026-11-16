// UWaterloo academic term helpers.
// Winter = Jan–Apr, Spring = May–Aug, Fall = Sep–Dec. Codes look like W27, S27, F26.

export type Season = "W" | "S" | "F";

export interface Term {
  season: Season;
  year: number; // full year, e.g. 2027
  code: string; // "W27"
  label: string; // "Winter 2027"
  start: Date;
  end: Date;
}

const SEASON_LABEL: Record<Season, string> = { W: "Winter", S: "Spring", F: "Fall" };
const SEASON_MONTHS: Record<Season, [number, number]> = { W: [0, 3], S: [4, 7], F: [8, 11] };

export function makeTerm(season: Season, year: number): Term {
  const [startMonth, endMonth] = SEASON_MONTHS[season];
  return {
    season,
    year,
    code: `${season}${String(year % 100).padStart(2, "0")}`,
    label: `${SEASON_LABEL[season]} ${year}`,
    start: new Date(year, startMonth, 1),
    end: new Date(year, endMonth + 1, 0, 23, 59, 59),
  };
}

export function currentTerm(now: Date = new Date()): Term {
  const m = now.getMonth();
  const season: Season = m <= 3 ? "W" : m <= 7 ? "S" : "F";
  return makeTerm(season, now.getFullYear());
}

export function nextTerm(t: Term): Term {
  if (t.season === "W") return makeTerm("S", t.year);
  if (t.season === "S") return makeTerm("F", t.year);
  return makeTerm("W", t.year + 1);
}

export function termFromCode(code: string): Term | null {
  const m = /^([FWS])(\d{2})$/i.exec(code.trim());
  if (!m) return null;
  return makeTerm(m[1].toUpperCase() as Season, 2000 + Number(m[2]));
}

function seasonFromWord(word: string): Season {
  const w = word.toLowerCase();
  if (w === "fall") return "F";
  if (w === "winter") return "W";
  return "S"; // spring / summer both map to the Spring term
}

function normalizeYear(raw: string): number | null {
  const n = Number(raw);
  const year = raw.length === 2 ? 2000 + n : n;
  return year >= 2018 && year <= 2040 ? year : null;
}

/** Find every term mentioned in a piece of text ("F26", "Fall 2026", "Winter '27", "2027 Spring"). */
export function extractTerms(text: string): Term[] {
  const found = new Map<string, Term>();
  const add = (season: Season, rawYear: string) => {
    const year = normalizeYear(rawYear);
    if (year === null) return;
    const term = makeTerm(season, year);
    found.set(term.code, term);
  };

  for (const m of text.matchAll(/\b(fall|winter|spring|summer)\s*(?:term\s*)?['’]?\s*(20\d{2}|\d{2})\b/gi)) {
    add(seasonFromWord(m[1]), m[2]);
  }
  for (const m of text.matchAll(/\b(20\d{2})\s*(fall|winter|spring|summer)\b/gi)) {
    add(seasonFromWord(m[2]), m[1]);
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9])([FWSfws])['’]?(\d{2})(?![A-Za-z0-9])/g)) {
    add(m[1].toUpperCase() as Season, m[2]);
  }
  return [...found.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export type TermStatus = "EXPIRED" | "CURRENT" | "UPCOMING";

export function termStatus(term: Term, now: Date = new Date()): TermStatus {
  if (term.end.getTime() < now.getTime()) return "EXPIRED";
  if (term.start.getTime() > now.getTime()) return "UPCOMING";
  return "CURRENT";
}

/** Pick the term a link is recruiting for: the latest non-expired one, else null. */
export function pickTargetTerm(text: string, now: Date = new Date()): { term: Term | null; onlyExpired: boolean } {
  const terms = extractTerms(text);
  if (terms.length === 0) return { term: null, onlyExpired: false };
  const live = terms.filter((t) => termStatus(t, now) !== "EXPIRED");
  if (live.length === 0) return { term: null, onlyExpired: true };
  return { term: live[live.length - 1], onlyExpired: false };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Best-effort deadline parse: "due Jan 12", "deadline: September 20th", "closes Nov 30, 2026". */
export function extractDeadline(text: string, now: Date = new Date()): Date | null {
  const m =
    /(?:due|deadline|closes?|closing|apply by|by|until)\s*(?:on|:|-)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i.exec(
      text,
    );
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  let date = new Date(year, month, day, 23, 59, 0);
  // No explicit year and the date is well in the past: it means next year.
  if (!m[3] && date.getTime() < now.getTime() - 60 * 24 * 3600 * 1000) {
    year += 1;
    date = new Date(year, month, day, 23, 59, 0);
  }
  return date;
}
