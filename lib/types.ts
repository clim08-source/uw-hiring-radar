// Shapes shared by the API routes and the client components.

export const TRACKER_STATUSES = ["SAVED", "APPLIED", "INTERVIEW", "OFFER", "REJECTED"] as const;
export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

export interface ClubDTO {
  id: string;
  name: string;
  source: string;
  category: string | null;
  instagramHandle: string | null;
  websiteUrl: string | null;
  linkInBioUrl: string | null;
  sourceUrl: string | null;
  lastScrapedAt: string | null;
}

export interface OpportunityDTO {
  id: string;
  title: string;
  targetTerm: string | null;
  url: string;
  roleType: string;
  status: string;
  formProvider: string | null;
  deadline: string | null;
  confidence: number;
  classifier: string;
  reason: string | null;
  discoveredAt: string;
  lastVerifiedAt: string;
  club: ClubDTO;
}

export interface TrackedDTO {
  id: string;
  opportunityId: string | null;
  clubName: string;
  roleTitle: string;
  targetTerm: string | null;
  url: string | null;
  status: TrackerStatus;
  notes: string | null;
  deadline: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScrapeRunDTO {
  id: string;
  status: string;
  phase: string;
  clubsDiscovered: number;
  clubsTotal: number;
  clubsScraped: number;
  opportunitiesFound: number;
  classifier: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StatsDTO {
  clubs: number;
  clubsBySource: Record<string, number>;
  clubsWithLinkInBio: number;
  openOpportunities: number;
  currentTerm: string;
  nextTerm: string;
  classifier: string;
}
