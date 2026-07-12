import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  fetchDrills,
  fetchStats,
  submitResults,
  type AnalysisResponse,
  type Drill,
  type WordResult,
  type WordStat,
} from "./api";
import { gradeDrill } from "./grade";

type Tab = "practice" | "stats";
type Phase = "idle" | "loading" | "typing" | "submitting" | "done";

function missRate(stat: WordStat): string {
  if (stat.attempts === 0) return "-";
  return `${Math.round((stat.misses / stat.attempts) * 100)}%`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("practice");
  const [phase, setPhase] = useState<Phase>("idle");
  const [drills, setDrills] = useState<Drill[]>([]);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [current, setCurrent] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<WordResult[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [stats, setStats] = useState<WordStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clock for the sentence on screen. It only ever counts time you spent
  // actually typing: it starts on your first keystroke rather than on display,
  // and it stops when you leave the tab. `banked` holds the time from earlier
  // runs on this same sentence so pausing resumes instead of restarting.
  const startedAt = useRef<number | null>(null);
  const banked = useRef(0);

  function elapsedMs(): number {
    const running = startedAt.current ? Date.now() - startedAt.current : 0;
    return banked.current + running;
  }

  function stopClock() {
    if (startedAt.current === null) return;
    banked.current += Date.now() - startedAt.current;
    startedAt.current = null;
  }

  function resetClock() {
    startedAt.current = null;
    banked.current = 0;
    setElapsed(0);
  }

  useEffect(() => {
    if (tab !== "practice" || phase !== "typing") return;
    const id = setInterval(() => setElapsed(elapsedMs()), 100);
    return () => clearInterval(id);
  }, [tab, phase]);

  // Put the cursor back in the box on a new sentence and on returning from the
  // Stats tab, otherwise you come back mid-sentence and type into nothing.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tab === "practice" && phase === "typing") inputRef.current?.focus();
  }, [tab, phase, index]);

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
      setDurations([]);
      setIndex(0);
      setCurrent("");
      setResults([]);
      setAnalysis(null);
      resetClock();
      setPhase("typing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the backend.");
      setPhase("idle");
    }
  }

  async function finishSession(allTyped: string[], allDurations: number[]) {
    const perDrill = drills.map((drill, i) => {
      const typedText = allTyped[i] ?? "";
      return {
        sentence: drill.sentence,
        typed: typedText,
        duration_ms: allDurations[i] ?? 0,
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

  async function openStats() {
    stopClock(); // freeze the sentence timer while you're off reading stats
    setTab("stats");
    setError(null);
    try {
      const data = await fetchStats();
      setStats(data.words);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load stats.");
    }
  }

  function nextSentence() {
    const updatedTyped = [...typed];
    updatedTyped[index] = current;
    setTyped(updatedTyped);

    stopClock();
    const updatedDurations = [...durations];
    updatedDurations[index] = banked.current;
    setDurations(updatedDurations);
    resetClock();

    setCurrent("");
    if (index + 1 >= drills.length) {
      finishSession(updatedTyped, updatedDurations);
    } else {
      setIndex(index + 1);
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    if (startedAt.current === null) startedAt.current = Date.now();
    setCurrent(e.target.value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      nextSentence();
    }
  }

  const correctCount = results.filter((r) => r.correct).length;
  const drillingCount = stats?.filter((s) => s.status === "drilling").length ?? 0;
  const masteredCount = stats?.filter((s) => s.status === "mastered").length ?? 0;

  // Under a second the sample is too small to mean anything, so hold at 0
  // instead of flashing a 300 wpm reading off a single keystroke.
  const liveWpm =
    elapsed > 1000 ? Math.round(current.length / 5 / (elapsed / 60000)) : 0;

  return (
    <>
      <nav className="tabs">
        <button
          className={tab === "practice" ? "tab tab-active" : "tab"}
          onClick={() => setTab("practice")}
        >
          Practice
        </button>
        <button
          className={tab === "stats" ? "tab tab-active" : "tab"}
          onClick={openStats}
        >
          Stats
        </button>
      </nav>

      <div className="card">
        {tab === "practice" && (
          <>
            {phase === "idle" && (
              <>
                <p className="instruction">Click start to begin your session.</p>
                <button onClick={startSession}>Start session</button>
                {error && <p className="error">{error}</p>}
              </>
            )}

            {phase === "loading" && <p>Loading your drills…</p>}

            {phase === "typing" && drills[index] && (
              <>
                <div className="drill-header">
                  <p className="progress">
                    Sentence {index + 1} of {drills.length}
                  </p>
                  <p className="timer">
                    {Math.floor(elapsed / 1000)}s
                    <span className="timer-wpm">{liveWpm} wpm</span>
                  </p>
                </div>
                <p className="prompt">{drills[index].sentence}</p>
                <input
                  key={index}
                  ref={inputRef}
                  className="typing-input"
                  value={current}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Type the sentence above…"
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
                        <b>{w.word}</b> {w.reason}
                      </p>
                    ))}
                  </>
                )}
                <button onClick={startSession}>Practice again</button>
              </div>
            )}
          </>
        )}

        {tab === "stats" && (
          <>
            {stats === null && !error && <p>Loading your stats…</p>}

            {stats && stats.length === 0 && (
              <p>No words tracked yet. Run a session first.</p>
            )}

            {stats && stats.length > 0 && (
              <>
                <p className="recap">
                  {stats.length} words tracked · {drillingCount} still drilling ·{" "}
                  {masteredCount} mastered
                </p>
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>word</th>
                      <th>attempts</th>
                      <th>misses</th>
                      <th>miss rate</th>
                      <th>status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr key={s.word}>
                        <td className="stat-word">{s.word}</td>
                        <td>{s.attempts}</td>
                        <td>{s.misses}</td>
                        <td>{missRate(s)}</td>
                        <td>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">
                  Words per minute is being recorded now and will show up here
                  once you have a few sessions behind you.
                </p>
              </>
            )}

            {error && <p className="error">{error}</p>}
          </>
        )}
      </div>
    </>
  );
}
