// Term-aware hiring classifier.
// Uses Gemini (GEMINI_API_KEY) or OpenAI (OPENAI_API_KEY) when a key is present, and a
// regex / keyword classifier otherwise (or whenever the LLM call fails).

import { hostMatches } from "./http";
import { currentTerm, nextTerm, pickTargetTerm, termFromCode, termStatus } from "./terms";

// MEMBER = open general-membership sign-up; GENERAL = an application with no specific role named.
export type RoleType = "EXEC" | "DIRECTOR" | "SUBTEAM" | "GENERAL" | "VOLUNTEER" | "MEMBER" | "OTHER";

export interface CandidateLink {
  title: string;
  url: string;
  /** Extra page text near the link, when we have it. */
  context?: string;
}

export interface ClassifiedLink extends CandidateLink {
  isHiring: boolean;
  targetTerm: string | null;
  roleType: RoleType;
  confidence: number;
  reason: string;
  classifier: string;
}

export const FORM_HOSTS = [
  "docs.google.com",
  "forms.gle",
  "typeform.com",
  "airtable.com",
  "tally.so",
  "forms.office.com",
  "forms.microsoft.com",
  "forms.cloud.microsoft",
  "jotform.com",
  "fillout.com",
  "notion.site",
  "notion.so",
  "qualtrics.com",
  "surveymonkey.com",
  "formstack.com",
  "wufoo.com",
  "paperform.co",
  "lever.co",
  "greenhouse.io",
  "ashbyhq.com",
];

export function isFormUrl(url: string): boolean {
  if (hostMatches(url, ["docs.google.com"])) return /\/forms\//.test(url);
  return hostMatches(url, FORM_HOSTS);
}

export function activeClassifierName(): string {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "llm:gemini";
  if (process.env.OPENAI_API_KEY) return "llm:openai";
  return "keyword";
}

// ---------------------------------------------------------------------------------------------
// Keyword / regex fallback
// ---------------------------------------------------------------------------------------------

const NON_HIRING_HOSTS = [
  "discord.gg",
  "discord.com",
  "instagram.com",
  "facebook.com",
  "fb.me",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "spotify.com",
  "github.com",
  "twitch.tv",
  "eventbrite.com",
  "eventbrite.ca",
  "lu.ma",
  "luma.com",
  "ticketfi.com",
  "paypal.com",
  "gofundme.com",
  "venmo.com",
  "medium.com",
  "substack.com",
  "mailchi.mp",
  "threads.net",
  "reddit.com",
  "whatsapp.com",
  "t.me",
  "apple.com",
  "maps.app.goo.gl",
  "play.google.com",
  "apps.apple.com",
  "drive.google.com",
  "zoom.us",
];

const NEGATIVE =
  /\b(discord|merch(andise)?|shop|store|sponsor(s|ship|ships)?|sponsorship package|partner(ship)? package|donat(e|ion|ions)|fundrais\w*|newsletter|mailing list|tickets?|rsvp|register(ation)?|sign[- ]?up for (the|our) (event|workshop)|workshop|podcast|blog|photos?|gallery|feedback|survey|petition|resources?|slides|recording|menu|playlist|constitution|waiver|reimbursement|event(s)?|competition|hackathon|conference|case comp\w*|tournament|gala|formal|trip|giveaway|raffle|vote|election|nomination form|nominations?|showcase|performance night|job posting|scholarships?|bursar(y|ies)|awards?)\b/i;

const CLOSED_HINT = /\b(closed|no longer accepting|applications? (are|have) (now )?closed|check back|coming soon|opening soon|stay tuned)\b/i;

const STRONG_POSITIVE =
  /\b(appl(y|ication|ications)|apps\b|hiring|we'?re hiring|recruit(ing|ment)?|open (roles|positions)|positions? available|join (the|our) (exec|team|executive)|exec(utive)? (team|apps?|applications?|positions?|recruit\w*)|director apps?|director applications?|subteam (recruit\w*|apps?|applications?)|team applications?|co-?op (posting|positions?)|interns?hip|lead apps?|lead applications?|coordinator applications?|volunteer applications?|call for (execs?|volunteers|directors))\b/i;

const WEAK_POSITIVE = /\b(join( us)?|get involved|careers?|jobs?|volunteer|become a (member|volunteer)|membership|member sign[- ]?up|sign[- ]?up|interest form|exec|director|subteam|lead|coordinator)\b/i;

export function roleTypeOf(text: string): RoleType {
  // "General Member Application" is membership even though it says "application".
  if (/\b(general members?|membership|members? (sign|form|regist|interest)|become a member)/i.test(text)) return "MEMBER";
  if (/\bdirector/i.test(text)) return "DIRECTOR";
  if (/\b(exec|execs|executive|vp|vice[- ]president|president|treasurer|secretary|leads?)\b/i.test(text)) return "EXEC";
  if (/\b(subteam|sub-team|team lead|engineering|firmware|mechanical|electrical|software|developer|designer|design team)\b/i.test(text)) return "SUBTEAM";
  if (/\bvolunteer/i.test(text)) return "VOLUNTEER";
  // A sign-up or interest form with no role and no application wording is a membership sign-up.
  if (/\b(sign[- ]?up|signup|interest form|join (us|now|the club|our club)|register)\b/i.test(text) && !/\b(appl(y|ication|ications)|apps|hiring|recruit\w*|positions?|roles?|team)\b/i.test(text)) return "MEMBER";
  return "GENERAL";
}

export function classifyWithKeywords(link: CandidateLink, now: Date = new Date()): ClassifiedLink {
  const text = `${link.title} ${link.context ?? ""}`.replace(/\s+/g, " ").trim();
  let urlText = link.url;
  try {
    urlText = decodeURIComponent(new URL(link.url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    // keep raw
  }
  // Hiring keywords must come from the link's own label or URL; surrounding text is only
  // used to find the term, since phrases like "terms apply" show up in unrelated copy.
  const own = `${link.title} ${urlText}`;
  const haystack = `${text} ${urlText}`;
  const base = { ...link, classifier: "keyword", roleType: roleTypeOf(own) };
  const reject = (reason: string): ClassifiedLink => ({ ...base, isHiring: false, targetTerm: null, confidence: 0.05, reason });

  if (/^mailto:|^tel:/i.test(link.url)) return reject("contact link");
  if (hostMatches(link.url, NON_HIRING_HOSTS)) return reject("social / non-hiring host");

  const strong = STRONG_POSITIVE.test(own);
  const weak = WEAK_POSITIVE.test(own);
  const form = isFormUrl(link.url);

  if (NEGATIVE.test(link.title) && !strong) return reject("non-hiring link (events, merch, sponsors, etc.)");
  if (!strong && !weak) return reject("no hiring keywords");
  if (CLOSED_HINT.test(link.title)) return reject("link text says applications are closed");

  const { term, onlyExpired } = pickTargetTerm(haystack, now);
  if (onlyExpired) return reject("names only past terms");

  let confidence = strong ? 0.6 : 0.35;
  const reasons = [strong ? "hiring keywords" : "weak join / sign-up keywords"];
  if (form) {
    confidence += 0.2;
    reasons.push("points at a form");
  }
  if (term) {
    confidence += 0.15;
    reasons.push(`targets ${term.code} (${termStatus(term, now).toLowerCase()})`);
  }
  if (NEGATIVE.test(link.title)) {
    confidence -= 0.2;
    reasons.push("mixed with non-hiring wording");
  }
  confidence = Math.max(0, Math.min(0.95, confidence));

  return {
    ...base,
    isHiring: confidence >= 0.5,
    targetTerm: term?.code ?? null,
    confidence,
    reason: reasons.join("; "),
  };
}

// ---------------------------------------------------------------------------------------------
// LLM classification
// ---------------------------------------------------------------------------------------------

interface LlmResult {
  index: number;
  isHiring: boolean;
  title?: string;
  targetTerm?: string | null;
  roleType?: string;
  expired?: boolean;
  confidence?: number;
  reason?: string;
}

function buildPrompt(clubName: string, links: CandidateLink[], now: Date): string {
  const cur = currentTerm(now);
  const nxt = nextTerm(cur);
  const list = links
    .map((l, i) => `${i}. title: ${JSON.stringify(l.title.slice(0, 160))} | url: ${l.url}${l.context ? ` | context: ${JSON.stringify(l.context.slice(0, 240))}` : ""}`)
    .join("\n");
  return `You classify links from the link-in-bio page of a University of Waterloo (UWaterloo) student club or student design team.

Today's date: ${now.toISOString().slice(0, 10)}. Current UW term: ${cur.code} (${cur.label}). Next term: ${nxt.code} (${nxt.label}).

UWaterloo conventions:
- Terms: Fall = Sep–Dec ("F26", "Fall 2026"), Winter = Jan–Apr ("W27", "Winter 2027"), Spring = May–Aug ("S27", "Spring 2027", sometimes "Summer").
- Hiring wording: "Exec Apps", "Exec Applications", "Director Applications", "Subteam Recruiting", "Team Applications", "Lead Apps", "Join the team", "We're hiring", "Volunteer applications".
- Clubs recruit for the upcoming term near the end of the current one, and for the current term in its first weeks.

For each link decide whether it is an ACTIVE application to join the club's team (exec, director, subteam, general team member, volunteer role).
- NOT hiring: Discord / social links, merch, sponsorship or partner packages, donations, event sign-ups or tickets, newsletters, general websites, resources, competitions, elections.
- A link whose only named term has already ended (before ${cur.code}) is expired: set "expired": true and "isHiring": false.
- A link with no term that reads like a standing application is hiring with lower confidence.
- roleType: use MEMBER for open general-membership sign-ups or interest forms anyone can fill in; use EXEC / DIRECTOR / SUBTEAM / VOLUNTEER for selective roles; GENERAL for an application that names no specific role.

Club: ${clubName}
Links:
${list}

Return ONLY JSON of the form:
{"results":[{"index":0,"isHiring":true,"title":"short clean title","targetTerm":"W27","roleType":"EXEC|DIRECTOR|SUBTEAM|GENERAL|VOLUNTEER|MEMBER|OTHER","expired":false,"confidence":0.0,"reason":"short reason"}]}
Include one entry for every link index. "targetTerm" is a term code like "W27" or null.`;
}

async function callGemini(prompt: string): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  return res.text ?? "";
}

async function callOpenAI(prompt: string): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });
  return res.choices[0]?.message?.content ?? "";
}

const ROLE_TYPES: RoleType[] = ["EXEC", "DIRECTOR", "SUBTEAM", "GENERAL", "VOLUNTEER", "MEMBER", "OTHER"];

async function classifyWithLlm(clubName: string, links: CandidateLink[], now: Date, name: string): Promise<ClassifiedLink[]> {
  const prompt = buildPrompt(clubName, links, now);
  const raw = name === "llm:gemini" ? await callGemini(prompt) : await callOpenAI(prompt);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as { results?: LlmResult[] };
  const byIndex = new Map((parsed.results ?? []).map((r) => [r.index, r]));

  return links.map((link, i) => {
    const r = byIndex.get(i);
    if (!r) return classifyWithKeywords(link, now);
    // Deterministic guard: never trust the model on whether a named term is over.
    const term = r.targetTerm ? termFromCode(String(r.targetTerm)) : null;
    const termExpired = term ? termStatus(term, now) === "EXPIRED" : false;
    const roleType = ROLE_TYPES.includes(r.roleType as RoleType) ? (r.roleType as RoleType) : "GENERAL";
    return {
      ...link,
      title: r.title?.trim() || link.title,
      isHiring: Boolean(r.isHiring) && !r.expired && !termExpired,
      targetTerm: term && !termExpired ? term.code : null,
      roleType,
      confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.7))),
      reason: termExpired ? `term ${term?.code} has ended` : r.reason?.slice(0, 200) || "LLM classification",
      classifier: name,
    };
  });
}

/** Classify a club's links. Falls back to keywords with no API key or on any LLM error. */
export async function classifyLinks(clubName: string, links: CandidateLink[], now: Date = new Date()): Promise<ClassifiedLink[]> {
  if (links.length === 0) return [];
  const name = activeClassifierName();
  if (name !== "keyword") {
    try {
      return await classifyWithLlm(clubName, links.slice(0, 60), now, name);
    } catch (err) {
      console.warn(`[classifier] ${name} failed for ${clubName}, using keyword fallback:`, (err as Error).message);
    }
  }
  return links.map((l) => classifyWithKeywords(l, now));
}
