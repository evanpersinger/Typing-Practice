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
  words: WordResult[];
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
