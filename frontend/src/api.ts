export const API_BASE = "http://localhost:8000";

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

export interface StatsResponse {
  words: WordStat[];
}

export interface NewWord {
  word: string;
  reason: string;
}

export interface AnalysisResponse {
  pattern_summary: string;
  new_words: NewWord[];
}

export async function fetchDrills(): Promise<DrillsResponse> {
  const res = await fetch(`${API_BASE}/drills`);
  if (!res.ok) throw new Error(`Failed to load drills (${res.status})`);
  return res.json();
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
  return res.json();
}

export async function submitResults(
  results: DrillResult[],
): Promise<AnalysisResponse> {
  const res = await fetch(`${API_BASE}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  });
  if (!res.ok) throw new Error(`Failed to submit results (${res.status})`);
  return res.json();
}
