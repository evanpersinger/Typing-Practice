import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  fetchDrills,
  fetchSessionDetail,
  fetchSessions,
  fetchStats,
  setProfile,
  submitResults,
  type AnalysisResponse,
  type Drill,
  type NewWord,
  type Profile,
  type SessionDetail,
  type SessionSummary,
  type StatsResponse,
  type TypingStats,
  type WordResult,
} from "./api";
import { gradeDrill } from "./grade";

type Tab = "practice" | "stats" | "words";
type Phase = "idle" | "loading" | "typing" | "submitting" | "done";

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

// SQLite hands back UTC with a space instead of a "T", so "Z" is appended
// before parsing rather than letting the browser read it as local time.
function formatSessionDate(startedAt: string): string {
  const date = new Date(`${startedAt.replace(" ", "T")}Z`);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface SessionRecapProps {
  words: WordResult[];
  typing: TypingStats;
  patternSummary: string | null;
  newWords: NewWord[];
}

/**
 * The pattern/speed/word-table recap, shared between the screen you land on
 * right after finishing a session and a past session pulled up from the
 * Stats tab dropdown. Same shape either way, live results or fetched ones.
 */
function SessionRecap({
  words,
  typing,
  patternSummary,
  newWords,
}: SessionRecapProps) {
  const correctCount = words.filter((w) => w.correct).length;
  const recap = recapWords(words);

  return (
    <>
      <section>
        <h2 className="stat-heading">overall</h2>
        <p className="stat-line">
          You spelled <b>{correctCount}</b> of {words.length} target words
          right · <b>{pct(correctCount, words.length)}</b> accuracy
        </p>
      </section>

      <section>
        <h2 className="stat-heading">speed</h2>
        <p className="stat-line">
          <b>{typing.avg_wpm}</b> wpm average · <b>{typing.best_wpm}</b> wpm
          best sentence
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

      {patternSummary && (
        <section>
          <h2 className="stat-heading">pattern</h2>
          <p className="stat-line">{patternSummary}</p>
        </section>
      )}

      {newWords.length > 0 && (
        <section>
          <h2 className="stat-heading">added to your list</h2>
          {newWords.map((w) => (
            <p key={w.word} className="new-word">
              <b>{w.word}</b> {w.reason}
            </p>
          ))}
        </section>
      )}
    </>
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
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<number | "">("");
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(
    null,
  );
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
    setSessions(null);
    setSelectedSessionId("");
    setSessionDetail(null);
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
    setSessions(null);
    setSelectedSessionId("");
    setSessionDetail(null);
    resetSession();
  }

  async function startSession() {
    setError(null);
    setPhase("loading");
    try {
      const data = await fetchDrills();
      if (data.drills.length === 0) {
        setError("No words to practice yet. Add some to your seed word list.");
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
      const [statsData, sessionsData] = await Promise.all([
        fetchStats(),
        fetchSessions(),
      ]);
      setStats(statsData);
      setSessions(sessionsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load stats.");
    }
  }

  /** The plain list of what you're working on. Shares the stats endpoint rather
   *  than adding one of its own, and skips the sessions fetch that Stats needs:
   *  there's no session dropdown on this tab. */
  async function openWords() {
    stopClock(); // same as Stats — reading your list isn't typing time
    setTab("words");
    setError(null);
    try {
      setStats(await fetchStats());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your words.");
    }
  }

  /** Pull up one past session's recap. Clears the old one first so switching
   *  sessions never shows stale data under the newly picked date while the
   *  fetch is still in flight. */
  async function selectSession(id: number | "") {
    setSelectedSessionId(id);
    setSessionDetail(null);
    if (id === "") return;
    try {
      const detail = await fetchSessionDetail(id);
      setSessionDetail(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that session.");
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

  // Only words you have actually typed. A seeded word you've never seen says
  // nothing about your spelling, and right now forty of the forty are seeds.
  const drilled = stats?.words.filter((w) => w.attempts > 0) ?? [];
  const totalAttempts = drilled.reduce((sum, w) => sum + w.attempts, 0);
  const totalMisses = drilled.reduce((sum, w) => sum + w.misses, 0);

  // Every word with at least one miss, worst first. No cap: this table is
  // the one place the app tells you what to work on, not a highlight reel.
  const missed = drilled
    .filter((w) => w.misses > 0)
    .sort((a, b) => b.misses - a.misses || b.attempts - a.attempts);

  // Everything still in rotation. Unlike the table above this is the whole list,
  // not just the words you've missed: a word you haven't reached yet is still one
  // you need to practice. Alphabetical rather than the backend's worst-first,
  // because this is a list you scan for a word, not a ranking. Sorting the
  // filtered copy, so the order the stats tab relies on is left alone.
  const weak = (stats?.words.filter((w) => w.status === "drilling") ?? []).sort(
    (a, b) => a.word.localeCompare(b.word),
  );

  // The list screens and the start screen sit at the top. Everything else stays
  // centered, so a sentence you're typing lands under your eyes. Loading holds
  // the start screen's position, since it's still the start screen on display.
  const cardClass =
    tab === "words"
      ? "card card-words"
      : tab === "stats"
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
        <button
          className={tab === "words" ? "tab tab-active" : "tab"}
          onClick={openWords}
        >
          Words
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
                <SessionRecap
                  words={results}
                  typing={analysis.typing}
                  patternSummary={analysis.pattern_summary}
                  newWords={analysis.new_words}
                />
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
                <section className="stat-columns">
                  <div className="stat-column">
                    <span className="stat-value">
                      {pct(totalAttempts - totalMisses, totalAttempts)}
                    </span>
                    <span className="stat-label">accuracy</span>
                  </div>
                  <div className="stat-column">
                    <span className="stat-value">{stats.typing.avg_wpm}</span>
                    <span className="stat-label">avg wpm</span>
                  </div>
                  <div className="stat-column">
                    <span className="stat-value">{stats.typing.best_wpm}</span>
                    <span className="stat-label">best wpm</span>
                  </div>
                </section>

                <section>
                  <h2 className="stat-heading">words you struggle with</h2>
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
                  <h2 className="stat-heading">sessions</h2>
                  <select
                    className="session-select"
                    value={selectedSessionId}
                    onChange={(e) =>
                      selectSession(
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">Select a session…</option>
                    {sessions?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {formatSessionDate(s.started_at)}
                      </option>
                    ))}
                  </select>

                  {selectedSessionId !== "" &&
                    (sessionDetail && sessionDetail.id === selectedSessionId ? (
                      <div className="summary session-gap">
                        <SessionRecap
                          words={sessionDetail.words}
                          typing={sessionDetail.typing}
                          patternSummary={sessionDetail.pattern_summary}
                          newWords={sessionDetail.new_words}
                        />
                      </div>
                    ) : (
                      <p className="session-gap">Loading session…</p>
                    ))}
                </section>
              </div>
            )}

            {error && <p className="error">{error}</p>}
          </>
        )}

        {tab === "words" && (
          <>
            {stats === null && !error && <p>Loading your words…</p>}

            {stats && (
              <div className="stats">
                <section>
                  <h2 className="words-heading">Weak Words</h2>
                  <p className="words-note">
                    these are words you need to practice
                  </p>
                  {weak.length === 0 ? (
                    <p className="stat-line">
                      Nothing in rotation right now — you've mastered the lot.
                    </p>
                  ) : (
                    <ul className="word-list">
                      {weak.map((w) => (
                        <li key={w.word} className="stat-word">
                          {w.word}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}

            {error && <p className="error">{error}</p>}
          </>
        )}
      </div>
    </>
  );
}
