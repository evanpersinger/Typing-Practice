export const API_BASE = "http://localhost:8000";

/** Which world you're in. `personal` is your real data; `testing` is a separate
 *  database you can throw junk at. The backend keys off the header below. */
export type Profile = "personal" | "testing";

// Deliberately not persisted. The app asks every time it loads, so you can't
// come back tomorrow and start feeding junk into your real numbers because a
// setting remembered something you forgot.
let profile: Profile = "personal";

export function setProfile(next: Profile): void {
  profile = next;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Profile": profile, ...extra };
}

export interface Drill {
  sentence: string;
  target_words: string[];
}

export interface DrillsResponse {
  words: string[];
  drills: Drill[];
}

export interface WordResult {
  word: string;
  typed: string;
  correct: boolean;
}

export interface DrillResult {
  sentence: string;
  typed: string;
  duration_ms: number;
  words: WordResult[];
}

export interface WordStat {
  word: string;
  attempts: number;
  misses: number;
  streak: number;
  status: string;
  source: string;
  last_seen: string | null;
}

export interface TypingStats {
  drills: number;
  avg_wpm: number;
  best_wpm: number;
}

export interface StatsResponse {
  words: WordStat[];
  typing: TypingStats;
}

export interface NewWord {
  word: string;
  reason: string;
}

export interface AnalysisResponse {
  pattern_summary: string;
  new_words: NewWord[];
  // Speed for the session you just finished, from the same query that backs the
  // stats tab, so the two numbers can never disagree.
  typing: TypingStats;
}

export async function fetchDrills(): Promise<DrillsResponse> {
  const res = await fetch(`${API_BASE}/drills`, { headers: headers() });
  if (!res.ok) throw new Error(`Failed to load drills (${res.status})`);
  return res.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${API_BASE}/stats`, { headers: headers() });
  if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
  return res.json();
}

export async function submitResults(
  results: DrillResult[],
): Promise<AnalysisResponse> {
  const res = await fetch(`${API_BASE}/results`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ results }),
  });
  if (!res.ok) throw new Error(`Failed to submit results (${res.status})`);
  return res.json();
}
