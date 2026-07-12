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
  type StatsResponse,
  type WordResult,
} from "./api";
import { gradeDrill } from "./grade";

type Tab = "practice" | "stats";
type Phase = "idle" | "loading" | "typing" | "submitting" | "done";

// The stats tab is a highlight reel, not an inventory. Ten rows is enough to
// show a pattern, and any more just buries it.
const TOP_N = 10;

// A word you get right four times out of five is one you can spell.
const ACCURACY_FLOOR = 0.8;

// Zero rather than a dash on an empty denominator: the stats tab always renders
// its real shape, so you can see what the numbers will look like before you have
// any. Nothing here divides by zero except a stats page you haven't earned yet.
function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
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
  const [stats, setStats] = useState<StatsResponse | null>(null);
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
      setStats(data);
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

  // Only words you have actually typed. A seeded word you've never seen says
  // nothing about your spelling, and right now forty of the forty are seeds.
  const drilled = stats?.words.filter((w) => w.attempts > 0) ?? [];
  const totalAttempts = drilled.reduce((sum, w) => sum + w.attempts, 0);
  const totalMisses = drilled.reduce((sum, w) => sum + w.misses, 0);

  const missed = drilled
    .filter((w) => w.misses > 0)
    .sort((a, b) => b.misses - a.misses || b.attempts - a.attempts)
    .slice(0, TOP_N);

  // Anything already named above is excluded, so no word lands in both lists.
  // The floor rather than a strict zero-miss rule: one bad day two months ago
  // shouldn't disqualify a word you now get right every single time.
  const flagged = new Set(missed.map((w) => w.word));
  const solid = drilled
    .filter(
      (w) =>
        !flagged.has(w.word) && 1 - w.misses / w.attempts >= ACCURACY_FLOOR,
    )
    .sort((a, b) => b.attempts - a.attempts || b.streak - a.streak)
    .slice(0, TOP_N);

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

      <div className={tab === "stats" ? "card card-stats" : "card"}>
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

            {stats && (
              <div className="stats">
                <section>
                  <h2 className="stat-heading">typing speed</h2>
                  <p className="stat-line">
                    <b>{stats.typing.avg_wpm}</b> wpm average ·{" "}
                    <b>{stats.typing.best_wpm}</b> wpm best ·{" "}
                    {stats.typing.drills} sentences timed
                  </p>
                </section>

                <section>
                  <h2 className="stat-heading">mistakes</h2>
                  <p className="stat-line">
                    <b>{totalMisses}</b> misses across {totalAttempts} attempts ·{" "}
                    <b>{pct(totalMisses, totalAttempts)}</b> miss rate
                  </p>
                </section>

                <div className="stat-tables">
                  <section>
                    <h2 className="stat-heading">commonly misspelled</h2>
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>word</th>
                          <th>missed</th>
                          <th>attempts</th>
                          <th>miss rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {missed.map((w) => (
                          <tr key={w.word}>
                            <td className="stat-word">{w.word}</td>
                            <td>{w.misses}</td>
                            <td>{w.attempts}</td>
                            <td>{pct(w.misses, w.attempts)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>

                  <section>
                    <h2 className="stat-heading">spelled correctly often</h2>
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>word</th>
                          <th>correct</th>
                          <th>attempts</th>
                          <th>accuracy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {solid.map((w) => (
                          <tr key={w.word}>
                            <td className="stat-word">{w.word}</td>
                            <td>{w.attempts - w.misses}</td>
                            <td>{w.attempts}</td>
                            <td>{pct(w.attempts - w.misses, w.attempts)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </div>
              </div>
            )}

            {error && <p className="error">{error}</p>}
          </>
        )}
      </div>
    </>
  );
}
