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
  setProfile,
  submitResults,
  type AnalysisResponse,
  type Drill,
  type Profile,
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

interface WordRecap {
  word: string;
  attempts: number;
  correct: number;
  typos: string[];
}

/**
 * Collapse a session's raw word results into one row per word. A word can come
 * up in more than one sentence, so it can be both hit and missed in the same
 * session, and the row has to say so rather than pick a side.
 *
 * The typos are the point of this table. Everywhere else in the app a miss is
 * just a number; here it's the actual thing you wrote.
 */
function recapWords(results: WordResult[]): WordRecap[] {
  const byWord = new Map<string, WordRecap>();

  for (const result of results) {
    const recap = byWord.get(result.word) ?? {
      word: result.word,
      attempts: 0,
      correct: 0,
      typos: [],
    };
    recap.attempts += 1;
    if (result.correct) {
      recap.correct += 1;
    } else if (result.typed && !recap.typos.includes(result.typed)) {
      recap.typos.push(result.typed);
    }
    byWord.set(result.word, recap);
  }

  // Worst first: the words you missed are why you're on this screen.
  return [...byWord.values()].sort(
    (a, b) =>
      b.attempts - b.correct - (a.attempts - a.correct) ||
      a.word.localeCompare(b.word),
  );
}

export default function App() {
  // Null until you've picked one, which is the whole point: there's no default
  // to fall through, so nothing can be read or written before you've said which
  // world you're in.
  const [profile, setActiveProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>("practice");
  const [phase, setPhase] = useState<Phase>("idle");
  const [drills, setDrills] = useState<Drill[]>([]);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [current, setCurrent] = useState("");
  const [results, setResults] = useState<WordResult[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clock for the sentence on screen. Nothing displays it any more, but it's
  // still what wpm is computed from, so it has to stay honest: it counts only
  // time you spent actually typing, starting on your first keystroke rather
  // than on display, and stopping when you leave the tab. `banked` holds the
  // time from earlier runs on this same sentence, so pausing resumes instead of
  // restarting.
  const startedAt = useRef<number | null>(null);
  const banked = useRef(0);

  function stopClock() {
    if (startedAt.current === null) return;
    banked.current += Date.now() - startedAt.current;
    startedAt.current = null;
  }

  function resetClock() {
    startedAt.current = null;
    banked.current = 0;
  }

  // Put the cursor back in the box on a new sentence and on returning from the
  // Stats tab, otherwise you come back mid-sentence and type into nothing.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tab === "practice" && phase === "typing") inputRef.current?.focus();
  }, [tab, phase, index]);

  /** Wipe every trace of the last session. Whoever clears state, clears all of
   *  it: a stale `results` or a running clock leaking into the next session is
   *  the kind of bug you only notice in the numbers weeks later. */
  function resetSession() {
    setDrills([]);
    setTyped([]);
    setDurations([]);
    setIndex(0);
    setCurrent("");
    setResults([]);
    setAnalysis(null);
    resetClock();
  }

  function chooseProfile(next: Profile) {
    setProfile(next); // every request from here on carries this profile
    setActiveProfile(next);
    setTab("practice");
    setPhase("idle");
    setError(null);
    setStats(null);
    resetSession();
  }

  /** Back to the picker. Stats and session state are dropped on the way out, or
   *  you'd be looking at one profile's numbers while typing into another's. */
  function switchProfile() {
    setActiveProfile(null);
    setTab("practice");
    setPhase("idle");
    setError(null);
    setStats(null);
    resetSession();
  }

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
      resetSession();
      setDrills(data.drills);
      setPhase("typing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the backend.");
      setPhase("idle");
    }
  }

  /**
   * Submit the finished sentences and show the results.
   *
   * `count` is how many sentences you actually pressed Enter on. It's the whole
   * set on a normal run, and fewer when you end early. Only completed sentences
   * are graded: a half-typed one isn't a misspelling, it's an interruption, and
   * counting it would put a word back in rotation you never got to finish.
   */
  async function finishSession(
    allTyped: string[],
    allDurations: number[],
    count: number,
  ) {
    const perDrill = drills.slice(0, count).map((drill, i) => {
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

  // Back to the start screen without spending a Claude call. "Practice again"
  // used to be the only way off this screen, and it committed you to a whole
  // new session just to leave.
  function backToPractice() {
    resetSession();
    setPhase("idle");
  }

  /** Quit mid-session and keep the sentences you finished.
   *
   *  A sentence counts once you've pressed Enter on it, so `index` is exactly
   *  how many are real. The one on screen and everything after it is dropped.
   *  Quitting on the very first sentence means there's nothing to submit, so we
   *  skip the round trip and the Claude call entirely. */
  function endSession() {
    stopClock();
    if (index === 0) {
      backToPractice();
      return;
    }
    finishSession(typed, durations, index);
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
      finishSession(updatedTyped, updatedDurations, drills.length);
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
  const recap = recapWords(results);

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

  // Stats and the start screen both sit at the top. Everything else stays
  // centered, so a sentence you're typing lands under your eyes. Loading holds
  // the start screen's position, since it's still the start screen on display.
  const cardClass =
    tab === "stats"
      ? "card card-stats"
      : phase === "idle" || phase === "loading"
        ? "card card-top"
        : "card";

  if (profile === null) {
    return (
      <div className="card">
        <div className="profile-picker">
          <button onClick={() => chooseProfile("testing")}>Testing</button>
          <button onClick={() => chooseProfile("personal")}>Personal</button>
        </div>
      </div>
    );
  }

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

      {/* Always on screen, because a profile you can't see is a profile you can
          forget you're in. Click it to go back to the picker. */}
      <button className="profile-chip" onClick={switchProfile}>
        {profile}
      </button>

      <div className={cardClass}>
        {tab === "practice" && (
          <>
            {phase === "idle" && (
              <>
                <p className="instruction">Click start to begin your session.</p>
                <button className="start-session" onClick={startSession}>
                  Start session
                </button>
                {error && <p className="error">{error}</p>}
              </>
            )}

            {/* Claude is writing your sentences, which takes a while. The
                spinner is the only thing on screen that says so. */}
            {phase === "loading" && (
              <>
                <p className="instruction">Starting session…</p>
                <div className="spinner" />
              </>
            )}

            {phase === "typing" && drills[index] && (
              <>
                <p className="prompt">{drills[index].sentence}</p>
                <input
                  key={index}
                  ref={inputRef}
                  className="typing-input"
                  value={current}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button className="end-session" onClick={endSession}>
                  End session
                </button>
                {error && <p className="error">{error}</p>}
              </>
            )}

            {phase === "submitting" && <p>Checking your typing…</p>}

            {phase === "done" && analysis && (
              <div className="summary">
                <h1 className="results-title">Session results</h1>

                <section>
                  <h2 className="stat-heading">overall</h2>
                  <p className="stat-line">
                    You spelled <b>{correctCount}</b> of {results.length} target
                    words right · <b>{pct(correctCount, results.length)}</b>{" "}
                    accuracy
                  </p>
                </section>

                <section>
                  <h2 className="stat-heading">speed</h2>
                  <p className="stat-line">
                    <b>{analysis.typing.avg_wpm}</b> wpm average ·{" "}
                    <b>{analysis.typing.best_wpm}</b> wpm best sentence
                  </p>
                </section>

                <section>
                  <h2 className="stat-heading">words you practiced</h2>
                  <table className="stats-table">
                    <thead>
                      <tr>
                        <th>word</th>
                        <th>right</th>
                        <th>you typed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recap.map((w) => (
                        <tr key={w.word}>
                          <td className="stat-word">{w.word}</td>
                          <td>
                            {w.correct} of {w.attempts}
                          </td>
                          {/* A missed word with nothing typed is a sentence you
                              cut short, which is worth seeing as its own thing
                              rather than as a blank cell. */}
                          <td className="stat-word">
                            {w.correct === w.attempts
                              ? "✓"
                              : w.typos.length > 0
                                ? w.typos.join(", ")
                                : "nothing"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section>
                  <h2 className="stat-heading">pattern</h2>
                  <p className="stat-line">{analysis.pattern_summary}</p>
                </section>

                {analysis.new_words.length > 0 && (
                  <section>
                    <h2 className="stat-heading">added to your list</h2>
                    {analysis.new_words.map((w) => (
                      <p key={w.word} className="new-word">
                        <b>{w.word}</b> {w.reason}
                      </p>
                    ))}
                  </section>
                )}

                <button onClick={backToPractice}>Back to practice</button>
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
