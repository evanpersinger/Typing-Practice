import { useState, type KeyboardEvent } from "react";
import {
  fetchDrills,
  submitResults,
  type AnalysisResponse,
  type Drill,
  type WordResult,
} from "./api";
import { gradeDrill } from "./grade";

type Phase = "idle" | "loading" | "typing" | "submitting" | "done";

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [drills, setDrills] = useState<Drill[]>([]);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [results, setResults] = useState<WordResult[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startSession() {
    setError(null);
    setPhase("loading");
    try {
      const data = await fetchDrills();
      if (data.drills.length === 0) {
        setError("No words to practice yet. Add some to seed_words.txt.");
        setPhase("idle");
        return;
      }
      setDrills(data.drills);
      setTyped([]);
      setIndex(0);
      setCurrent("");
      setResults([]);
      setAnalysis(null);
      setPhase("typing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the backend.");
      setPhase("idle");
    }
  }

  async function finishSession(allTyped: string[]) {
    const perDrill = drills.map((drill, i) => {
      const typedText = allTyped[i] ?? "";
      return {
        sentence: drill.sentence,
        typed: typedText,
        words: gradeDrill(drill, typedText),
      };
    });
    setResults(perDrill.flatMap((d) => d.words));
    setPhase("submitting");
    try {
      const data = await submitResults(perDrill);
      setAnalysis(data);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit results.");
      setPhase("typing");
    }
  }

  function nextSentence() {
    const updated = [...typed];
    updated[index] = current;
    setTyped(updated);
    setCurrent("");
    if (index + 1 >= drills.length) {
      finishSession(updated);
    } else {
      setIndex(index + 1);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      nextSentence();
    }
  }

  const correctCount = results.filter((r) => r.correct).length;

  return (
    <div className="card">
      <h1>Typing Practice</h1>
      <p className="subtitle">Drill the words you actually misspell.</p>

      {phase === "idle" && (
        <>
          <button onClick={startSession}>Start session</button>
          {error && <p className="error">{error}</p>}
        </>
      )}

      {phase === "loading" && <p>Loading your drills…</p>}

      {phase === "typing" && drills[index] && (
        <>
          <p className="progress">
            Sentence {index + 1} of {drills.length}
          </p>
          <p className="prompt">{drills[index].sentence}</p>
          <input
            key={index}
            className="typing-input"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type the sentence above…"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="hint">Press Enter for the next sentence.</p>
          {error && <p className="error">{error}</p>}
        </>
      )}

      {phase === "submitting" && <p>Checking your typing…</p>}

      {phase === "done" && analysis && (
        <div className="summary">
          <p className="recap">
            You nailed {correctCount} of {results.length} target words.
          </p>
          <p>
            <b>Pattern:</b> {analysis.pattern_summary}
          </p>
          {analysis.new_words.length > 0 && (
            <>
              <p>
                <b>Added to your list:</b>
              </p>
              {analysis.new_words.map((w) => (
                <p key={w.word} className="new-word">
                  <b>{w.word}</b> — {w.reason}
                </p>
              ))}
            </>
          )}
          <button onClick={startSession}>Practice again</button>
        </div>
      )}
    </div>
  );
}
