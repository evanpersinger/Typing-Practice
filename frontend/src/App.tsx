import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  addWord,
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

// Text buttons, not filled boxes: the size, colour and cursor used to come from
// a global `button {}` rule, which is gone now, so they're stated here.
// Tailwind's reset gives buttons `cursor: default`, hence the explicit pointer.
const TEXT_BUTTON =
  "cursor-pointer text-[1.3rem] text-white hover:opacity-[0.55]";

// Shared by the three nav buttons, which differ only in the active state.
const TAB = `${TEXT_BUTTON} border-b-2 py-0.5 no-underline`;
const TAB_ON = `${TAB} border-white font-semibold`;
const TAB_OFF = `${TAB} border-transparent`;

// Section headings: separated from body text by weight and size alone, never by
// dimming. Every bit of text on these pages stays pure white.
const HEADING = "mt-0 mb-2.5 text-[1.1rem] font-semibold";

// Both stats tables. The cell rules stay on the table via [&_th]/[&_td] rather
// than being repeated on every cell, which is how they read as one rule instead
// of thirty copies.
const TABLE =
  "w-full border-collapse text-[1.1rem] " +
  "[&_th]:border-b [&_th]:border-[#7d827e] [&_th]:py-2 [&_th]:pr-3 [&_th]:pl-0 [&_th]:text-left [&_th]:font-semibold " +
  "[&_td]:border-b [&_td]:border-[#3f4441] [&_td]:py-2 [&_td]:pr-3 [&_td]:pl-0";

// The Words grid is a fixed board: 6 across (matching index.css) by 10 down,
// the same 60 boxes whatever the word count. Filled boxes are what you're
// working on, empty ones are the room left, so the shape of the grid tells you
// how big your backlog is without counting anything.
const WORD_COLUMNS = 6;
const WORD_ROWS = 10;
const WORD_SLOTS = WORD_COLUMNS * WORD_ROWS;
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
        <h2 className={HEADING}>overall</h2>
        <p className="m-0 text-[1.4rem]">
          You spelled <b>{correctCount}</b> of {words.length} target words
          right · <b>{pct(correctCount, words.length)}</b> accuracy
        </p>
      </section>

      <section>
        <h2 className={HEADING}>speed</h2>
        <p className="m-0 text-[1.4rem]">
          <b>{typing.avg_wpm}</b> wpm average · <b>{typing.best_wpm}</b> wpm
          best sentence
        </p>
      </section>

      <section>
        <h2 className={HEADING}>words you practiced</h2>
        <table className={TABLE}>
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
                <td className="font-mono">{w.word}</td>
                <td>
                  {w.correct} of {w.attempts}
                </td>
                {/* A missed word with nothing typed is a sentence you
                    cut short, which is worth seeing as its own thing
                    rather than as a blank cell. */}
                <td className="font-mono">
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
          <h2 className={HEADING}>pattern</h2>
          <p className="m-0 text-[1.4rem]">{patternSummary}</p>
        </section>
      )}

      {newWords.length > 0 && (
        <section>
          <h2 className={HEADING}>added to your list</h2>
          {newWords.map((w) => (
            <p key={w.word} className="my-1.5">
              <b className="font-mono">{w.word}</b> {w.reason}
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
  const [newWord, setNewWord] = useState("");
  // Result of the last add. Separate from `error`, because "already on your
  // list" is an outcome, not a failure, and shouldn't render in red.
  const [wordNote, setWordNote] = useState<string | null>(null);

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
    setWordNote(null); // last visit's "added receipt" isn't news any more
    try {
      setStats(await fetchStats());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your words.");
    }
  }

  /** Add a word you want to practice. Refetches rather than splicing the new
   *  word into local state: the row the server stores is the normalized one,
   *  and inventing a second version of it here is how the two drift apart. */
  async function submitWord() {
    const word = newWord.trim();
    if (!word) return;
    setError(null);
    setWordNote(null);
    try {
      const result = await addWord(word);
      setNewWord("");
      setWordNote(
        result.added
          ? `Added ${result.word}.`
          : `${result.word} is already on your list.`,
      );
      setStats(await fetchStats());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that word.");
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

  // Always 60 boxes: the board never grows or shrinks. Whatever's left after the
  // words renders empty, which is what makes "47 words, 13 to spare" readable at
  // a glance. Past 60 the extra words aren't shown — the board is the board.
  const shownWeak = weak.slice(0, WORD_SLOTS);
  const emptyCells = WORD_SLOTS - shownWeak.length;


  // The list screens and the start screen sit at the top. Everything else stays
  // centered, so a sentence you're typing lands under your eyes. Loading holds
  // the start screen's position, since it's still the start screen on display.
  const cardClass =
    tab === "words"
      ? // Pulled hard into the top-left corner, out of #root's padding (which is
        // only there to clear the floating tab bar), and wider than the 880px
        // reading column since this is a six-across grid, not prose.
        "w-full max-w-[1280px] self-start -mt-10 -ml-4"
      : tab === "stats"
        ? // Stats reads like a page, not a prompt, so it starts top-left.
          "m-0 w-full max-w-[880px] self-start"
        : phase === "idle" || phase === "loading"
          ? // The start screen is two short lines; centering them leaves the
            // button floating in an empty page, so it pins to the top.
            "mx-auto my-0 w-full max-w-[880px] self-start"
          : // Centered, so the sentence you're typing lands under your eyes.
            // Auto margins rather than align-items, which clips the top of
            // anything taller than the viewport.
            "m-auto w-full max-w-[880px]";

  if (profile === null) {
    return (
      <div className="m-auto w-full max-w-[880px]">
        {/* The one screen where the buttons are the whole page, so they get to
            be real boxes rather than the text links used everywhere else. A
            faint fill on hover rather than the usual fade, since fading a box
            this size takes the label with it. */}
        <div className="flex gap-6">
          <button
            onClick={() => chooseProfile("testing")}
            className="flex-1 cursor-pointer rounded-xl border border-white px-6 py-[90px] text-[3.6rem] text-white no-underline hover:bg-white/8"
          >
            Testing
          </button>
          <button
            onClick={() => chooseProfile("personal")}
            className="flex-1 cursor-pointer rounded-xl border border-white px-6 py-[90px] text-[3.6rem] text-white no-underline hover:bg-white/8"
          >
            Personal
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Absolute, not fixed, so it scrolls away over a long stats table
          instead of floating on top of it. */}
      <nav className="absolute top-7 left-1/2 flex -translate-x-1/2 gap-6">
        <button
          className={tab === "practice" ? TAB_ON : TAB_OFF}
          onClick={() => setTab("practice")}
        >
          Practice
        </button>
        <button
          className={tab === "stats" ? TAB_ON : TAB_OFF}
          onClick={openStats}
        >
          Stats
        </button>
        <button
          className={tab === "words" ? TAB_ON : TAB_OFF}
          onClick={openWords}
        >
          Words
        </button>
      </nav>

      {/* Always on screen, because a profile you can't see is a profile you can
          forget you're in. Click it to go back to the picker. */}
      {/* The profile name is a wire value ("testing"), capitalized for display
          only — changing the value would mean changing the header the backend
          keys off, for the sake of a capital letter. */}
      <button
        className="absolute top-7 right-10 cursor-pointer rounded-full border border-white px-5.5 py-2 text-[1.6rem] text-white no-underline capitalize hover:opacity-[0.55]"
        onClick={switchProfile}
      >
        {profile}
      </button>

      <div className={cardClass}>
        {tab === "practice" && (
          <>
            {phase === "idle" && (
              <>
                <button
                  className="cursor-pointer rounded-[10px] border border-white px-13 py-6 text-[2.4rem] text-white no-underline hover:bg-white/8"
                  onClick={startSession}
                >
                  Start session
                </button>
                {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
              </>
            )}

            {/* Claude is writing your sentences, which takes a while. The
                spinner is the only thing on screen that says so. */}
            {phase === "loading" && (
              <>
                <p className="mt-0 mb-7 text-[2.4rem]">Starting session…</p>
                {/* One white arc on an invisible ring, rather than a white
                    circle over a gray one. Same reason everything else here is
                    pure white: no gray anywhere. */}
                <div className="size-11 animate-[spin_0.8s_linear_infinite] rounded-full border-[3px] border-transparent border-t-white" />
              </>
            )}

            {phase === "typing" && drills[index] && (
              <>
                {/* Prompt and input are deliberately the same size and face.
                    You read one while typing the other, so any mismatch makes
                    them harder to compare. */}
                <p className="mb-4 font-mono text-[1.9rem] leading-[1.6]">
                  {drills[index].sentence}
                </p>
                <input
                  key={index}
                  ref={inputRef}
                  className="w-full rounded-lg border border-[#4a4f4c] bg-[#1e2220] px-4.5 py-4 font-mono text-[1.9rem] text-white outline-none placeholder:text-[#7d827e] focus:border-white"
                  value={current}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {/* A way out, not an invitation. Small, so it never competes
                    with the sentence you're supposed to be reading. */}
                <button
                  className="mt-5 cursor-pointer rounded-lg border border-white px-8 py-3.5 text-[1.4rem] text-white no-underline hover:bg-white/8"
                  onClick={endSession}
                >
                  End session
                </button>
                {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
              </>
            )}

            {phase === "submitting" && <p>Checking your typing…</p>}

            {phase === "done" && analysis && (
              <div className="flex flex-col gap-7 leading-[1.6]">
                <h1 className="m-0 text-[2.4rem]">Session results</h1>
                <SessionRecap
                  words={results}
                  typing={analysis.typing}
                  patternSummary={analysis.pattern_summary}
                  newWords={analysis.new_words}
                />
                {/* self-start, or the flex column stretches it and a text
                    button renders as a full-width bar. */}
                <button
                  className={`${TEXT_BUTTON} self-start underline underline-offset-4`}
                  onClick={backToPractice}
                >
                  Back to practice
                </button>
              </div>
            )}
          </>
        )}

        {tab === "stats" && (
          <>
            {stats === null && !error && <p>Loading your stats…</p>}

            {stats && (
              <div className="flex flex-col gap-8">
                <section className="flex gap-12">
                  <div className="flex flex-col gap-1">
                    <span className="text-[2rem] font-semibold">
                      {pct(totalAttempts - totalMisses, totalAttempts)}
                    </span>
                    <span className="text-[1.1rem]">accuracy</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[2rem] font-semibold">
                      {stats.typing.avg_wpm}
                    </span>
                    <span className="text-[1.1rem]">avg wpm</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[2rem] font-semibold">
                      {stats.typing.best_wpm}
                    </span>
                    <span className="text-[1.1rem]">best wpm</span>
                  </div>
                </section>

                <section>
                  <h2 className={HEADING}>words you struggle with</h2>
                  <table className={TABLE}>
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
                          <td className="font-mono">{w.word}</td>
                          <td>{w.misses}</td>
                          <td>{w.attempts}</td>
                          <td>{pct(w.misses, w.attempts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section>
                  <h2 className={HEADING}>sessions</h2>
                  {/* Matches the typing input's look, so the dropdown reads as
                      part of the same UI instead of an unstyled browser
                      control. font-family: inherit, not Tailwind's sans stack,
                      to keep the app's face. */}
                  <select
                    className="rounded-lg border border-[#4a4f4c] bg-[#1e2220] px-3.5 py-2.5 text-[1.3rem] text-white [font-family:inherit] focus:border-white focus:outline-none"
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
                      <div className="mt-7 flex flex-col gap-7 leading-[1.6]">
                        <SessionRecap
                          words={sessionDetail.words}
                          typing={sessionDetail.typing}
                          patternSummary={sessionDetail.pattern_summary}
                          newWords={sessionDetail.new_words}
                        />
                      </div>
                    ) : (
                      <p className="mt-7">Loading session…</p>
                    ))}
                </section>
              </div>
            )}

            {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
          </>
        )}

        {tab === "words" && (
          <>
            {stats === null && !error && <p>Loading your words…</p>}

            {stats && (
              <div>
                <section>
                  <h2 className="mt-0 mb-2 text-[1.8rem] font-semibold">
                    Weak Words
                  </h2>
                  <p className="mt-0 mb-6 text-[1.3rem]">
                    these are words you need to practice
                  </p>

                  {/* Grid left, add-a-word right. items-start keeps the panel
                      at the top rather than stretching down ten rows. */}
                  <div className="flex items-start gap-8">
                    <ul className="grid min-w-0 flex-1 list-none grid-cols-6 gap-2 p-0 text-[1.1rem]">
                      {shownWeak.map((w) => (
                        <li
                          key={w.word}
                          className="rounded-md border border-white px-3.5 py-2.5 font-mono [overflow-wrap:anywhere]"
                        >
                          {w.word}
                        </li>
                      ))}
                      {/* Empty slots. The non-breaking space is what gives them
                          the same height as a box with a word in it. Hidden from
                          screen readers, since "blank, blank, blank" is noise. */}
                      {Array.from({ length: emptyCells }, (_, i) => (
                        <li
                          key={`empty-${i}`}
                          className="rounded-md border border-[#4a4f4c] px-3.5 py-2.5 font-mono"
                          aria-hidden="true"
                        >
                          {" "}
                        </li>
                      ))}
                    </ul>

                    <div className="shrink-0 grow-0 basis-[220px]">
                      {/* A form, so Enter submits without a key handler. */}
                      <form
                        className="flex flex-col gap-2.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          submitWord();
                        }}
                      >
                        <input
                          className="w-full rounded-md border border-[#4a4f4c] bg-[#1e2220] px-3.5 py-2.5 font-mono text-[1.1rem] text-white outline-none placeholder:text-[#7d827e] focus:border-white"
                          value={newWord}
                          onChange={(e) => setNewWord(e.target.value)}
                          placeholder="add a word"
                          autoComplete="off"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                        <button
                          type="submit"
                          className="cursor-pointer rounded-md border border-white px-6 py-2.5 text-[1.1rem] text-white no-underline hover:bg-white/8"
                        >
                          Add
                        </button>
                      </form>

                      {wordNote && (
                        <p className="mt-0 mb-4 text-[1.1rem]">{wordNote}</p>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
          </>
        )}
      </div>
    </>
  );
}
