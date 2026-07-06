import type { Drill, WordResult } from "./api";

/** Lowercase and strip surrounding punctuation so "Separate," == "separate". */
function normalize(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

/**
 * Grade one sentence by aligning the typed words to the expected words by
 * position. For each target word, we report what the user typed at that slot
 * and whether it matched. Good enough for copy-typing; word insertions or
 * deletions can shift alignment, which we accept for now.
 */
export function gradeDrill(drill: Drill, typed: string): WordResult[] {
  const expected = drill.sentence.split(/\s+/).filter(Boolean);
  const typedWords = typed.trim().split(/\s+/).filter(Boolean);
  const targets = new Set(drill.target_words.map(normalize));
  const results: WordResult[] = [];

  expected.forEach((word, i) => {
    const norm = normalize(word);
    if (targets.has(norm)) {
      const typedWord = typedWords[i] ?? "";
      results.push({
        word: norm,
        typed: typedWord,
        correct: normalize(typedWord) === norm,
      });
    }
  });
  return results;
}
