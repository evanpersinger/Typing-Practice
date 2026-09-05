import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  addWord,
  fetchDrills,
  fetchFreeWords,
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
import { gradeDrill, normalize } from "./grade";

type Tab = "practice" | "stats" | "words" | "free";

// Miss a word twice and it's a typo; three times and it's a habit worth adding
// to the weak list. A missed word slides this far down the board rather than
// repeating straight away, so you're recalling it and not copying the line above.
const STRIKES = 3;
const REQUEUE_AFTER = 5;

// Six words to a row, the whole batch on screen at once. Rows rather than a
// grid of equal columns, because a column wide enough for the longest word
// strands a five-letter one in the middle of it: this way the rows come out
// ragged and the words sit exactly one space apart (1ch, in a mono face).
const FREE_COLUMNS = 6;
const FREE_BOARD =
  "flex w-fit flex-col gap-y-5 rounded-xl border-[6px] border-[#4a4f4c] " +
  "px-10 py-8 font-mono text-[1.6rem] leading-none";

// A letter you got wrong, anywhere on the board. The same red the error line
// uses.
const FREE_MISS = "text-[#ff7a70]";

// A letter you haven't reached yet. White is what you've already typed, so the
// board fills in ahead of the caret as you go. Same grey as the input
// placeholder, for the same reason: it reads as text that isn't yours yet.
const FREE_PENDING = "text-[#7d827e]";

// Zero-width, so the caret moving through a word doesn't shove the rest of it
// sideways: the 2px border is cancelled by the 1px margin on either side.
const FREE_CARET =
  "inline-block h-[1.05em] w-0 -mx-px border-l-2 border-white align-[-0.15em]";

// Text buttons, not filled boxes: the size, colour and cursor used to come from
// a global `button {}` rule, which is gone now, so they're stated here.
// Tailwind's reset gives buttons `cursor: default`, hence the explicit pointer.
const TEXT_BUTTON =
  "cursor-pointer text-[1.3rem] text-white hover:opacity-[0.55]";

// The four nav buttons. Boxes rather than underlined text, so the active one is
// a faint fill instead of a border: the border is on all four now. Only the
// inactive ones take a hover fill, since two bg utilities on one element resolve
// by stylesheet order and the active tab would flicker lighter on hover.
// Warm sand rather than white, so the chrome you navigate with never reads as
// the words you're being tested on. The literal has to be written out at each
// use: Tailwind scans the source for class strings, so a colour interpolated
// from a variable never gets a rule generated for it.
const TAB =
  "cursor-pointer rounded-lg border border-[#c2a878] px-6 py-2.5 " +
  "text-[1.8rem] text-[#c2a878] no-underline";
const TAB_ON = `${TAB} bg-[#c2a878]/15`;
const TAB_OFF = `${TAB} hover:bg-[#c2a878]/8`;

// The way out of whichever session you're in. Pinned to the bottom-right so it
// sits opposite the intro blurb and out of the way of the words: a way out, not
// an invitation.
const END_BUTTON =
  "absolute right-10 bottom-7 cursor-pointer rounded-lg border border-white " +
  "px-8 py-3.5 text-[1.4rem] text-white no-underline hover:bg-white/8";

// What the mode you're on is for, and what you do. Pinned to the corner opposite
// the profile button and sized like the tab bar, because it's chrome rather than
// body text. The width cap keeps it off the card behind it.
const INTRO =
  "absolute top-7 left-10 m-0 max-w-[280px] text-[1.3rem] leading-[1.45]";

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

// A fixed 6-by-10 board: the same 60 cells whatever the word count, so the
// empty ones show how much room is left.
const WORD_COLUMNS = 6;
const WORD_ROWS = 10;
const WORD_SLOTS = WORD_COLUMNS * WORD_ROWS;

// Six 173px columns, each fitting a 14-character word. Needs an explicit width
// (table-fixed is ignored when width is auto) and shrink-0 (otherwise the flex
// row squeezes the board and clips words).
const WORD_TABLE_WIDTH = "w-[1095px] shrink-0";
type Phase = "idle" | "loading" | "typing" | "submitting" | "done";

// Free Type has no submit step: there's nothing to send at the end, words are
// added the moment they earn it, so it goes straight from typing to done.
type FreePhase = "idle" | "loading" | "typing" | "done";

/**
 * One word on the Free Type board, drawn character by character so what you
 * typed sits on top of what you were meant to type. `typed` is null for a word
 * you haven't reached yet.
 *
 * Red is per letter and never the whole word: once you've missed something,
 * where in the word you missed it is the only part worth looking at.
 */
function FreeWord({
  word,
  typed,
  active,
}: {
  word: string;
  typed: string | null;
  active: boolean;
}) {
  if (typed === null) return <span className={FREE_PENDING}>{word}</span>;

  const attempt = typed.toLowerCase();
  const letters = [...word];
  // A letter you never reached is wrong too, but only once you've moved on:
  // while you're still on the word it's just a letter you haven't typed.
  const wrong = letters.map((char, i) =>
    i < attempt.length ? attempt[i] !== char : !active,
  );
  // Anything past the end of the word renders as itself rather than being
  // dropped: you should see what you actually typed.
  const overflow = attempt.slice(word.length);
  // Only the word under the caret has letters that are still pending: on a word
  // you've moved past, everything you never reached is already marked wrong.
  const letterClass = (i: number) =>
    wrong[i] ? FREE_MISS : i < attempt.length ? "" : FREE_PENDING;

  return (
    <span>
      {letters.map((char, i) => (
        <Fragment key={i}>
          {active && i === attempt.length && <span className={FREE_CARET} />}
          <span className={letterClass(i)}>{char}</span>
        </Fragment>
      ))}
      {overflow && <span className={FREE_MISS}>{overflow}</span>}
      {active && attempt.length >= word.length && (
        <span className={FREE_CARET} />
      )}
    </span>
  );
}

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
          {/* Words you put on the list yourself, by misspelling them three
              times. Nothing here was nominated: the model stopped suggesting
              words because a word you've never typed outranks, next session,
              every word you actually keep getting wrong. */}
          <h2 className={HEADING}>added from your misses</h2>
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
  // The end-of-session recap is fetched either way, it just stays folded away
  // until you ask for it. Finishing a session shouldn't shove numbers at you.
  const [showRecap, setShowRecap] = useState(false);
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

  // Free Type shares nothing with a practice session on purpose: these are bare
  // words, not graded drills, and letting the two touch is how a stray word ends
  // up in your wpm.
  const [freePhase, setFreePhase] = useState<FreePhase>("idle");
  // The board on screen, and where you are in it. Attempts are indexed the same
  // way, so `freeAttempts[i]` is what you wrote for `freeWords[i]`; a word is
  // only ever inserted ahead of the cursor, which is what keeps those in step.
  const [freeWords, setFreeWords] = useState<string[]>([]);
  const [freeIndex, setFreeIndex] = useState(0);
  const [freeAttempts, setFreeAttempts] = useState<string[]>([]);
  const [freeCurrent, setFreeCurrent] = useState("");
  // Misses per word, this sitting only. Reset on every start: three strikes is
  // a claim about one session, not an all-time tally.
  const [freeMisses, setFreeMisses] = useState<Record<string, number>>({});
  const [freeAdded, setFreeAdded] = useState<string[]>([]);
  const [freeTypedCount, setFreeTypedCount] = useState(0);
  // Same deal as showRecap: the numbers are there if you go looking, but they
  // aren't the first thing you see when you stop.
  const [showFreeStats, setShowFreeStats] = useState(false);

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
  const freeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tab === "practice" && phase === "typing") inputRef.current?.focus();
  }, [tab, phase, index]);

  useEffect(() => {
    if (tab === "free" && freePhase === "typing") freeInputRef.current?.focus();
  }, [tab, freePhase, freeIndex]);

  // Type through the board and the next one takes its place, rather than the
  // session ending out from under you.
  useEffect(() => {
    if (tab !== "free" || freePhase !== "typing") return;
    if (freeIndex < freeWords.length) return;
    fetchFreeWords()
      .then((words) => {
        setFreeWords(words);
        setFreeIndex(0);
        setFreeAttempts([]);
      })
      .catch(() => setError("Could not load more words."));
  }, [tab, freePhase, freeIndex, freeWords.length]);

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
    setShowRecap(false);
    resetClock();
  }

  /** Same rule as resetSession: whoever clears Free Type clears all of it. A
   *  leftover miss count is a word added on its first mistake next time. */
  function resetFreeType() {
    setFreePhase("idle");
    setFreeWords([]);
    setFreeIndex(0);
    setFreeAttempts([]);
    setFreeCurrent("");
    setFreeMisses({});
    setFreeAdded([]);
    setFreeTypedCount(0);
    setShowFreeStats(false);
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
    resetFreeType();
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
    resetFreeType();
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

  /** Open the tab without starting anything, same as Practice. Switching tabs
   *  mid-thought shouldn't begin a session you didn't ask for. */
  function openFreeType() {
    stopClock(); // free typing isn't practice time, don't let it count
    setTab("free");
    setError(null);
  }

  async function startFreeType() {
    setError(null);
    setFreePhase("loading");
    try {
      const words = await fetchFreeWords();
      if (words.length === 0) {
        setError("No words came back. Every common word is already on your list.");
        setFreePhase("idle");
        return;
      }
      resetFreeType();
      setFreeWords(words);
      setFreePhase("typing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the backend.");
      setFreePhase("idle");
    }
  }

  /**
   * Grade the word you're on and move the cursor along.
   *
   * Right, and it's done for good. Wrong, and it's dealt back into the board
   * further down, pushing the last word off so the board stays ten rows. On the
   * third miss it's added to your weak list instead, because Practice takes
   * over from there and there's nothing left to learn from testing it again
   * this sitting.
   */
  async function commitFreeWord() {
    const word = freeWords[freeIndex];
    if (!word) return;
    const attempt = normalize(freeCurrent);
    setFreeCurrent("");
    setFreeTypedCount((n) => n + 1);
    setFreeIndex((i) => i + 1);
    setFreeAttempts((attempts) => [...attempts, attempt]);
    if (attempt === word) return;

    const misses = (freeMisses[word] ?? 0) + 1;
    setFreeMisses({ ...freeMisses, [word]: misses });

    if (misses < STRIKES) {
      setFreeWords((words) => {
        // Too near the end of the board to deal it back in. The next board is
        // different words anyway, so it just doesn't come round again.
        const at = freeIndex + REQUEUE_AFTER;
        if (at >= words.length) return words;
        const next = [...words];
        next.splice(at, 0, word);
        next.pop();
        return next;
      });
      return;
    }

    try {
      await addWord(word);
      setFreeAdded((added) => [...added, word]);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not add ${word}.`);
    }
  }

  /** Space ends a word here, the way it does when you type anything else, so it
   *  must never reach the box. Enter does the same for the last word of a line
   *  out of habit. An empty box submits nothing: a stray space isn't a miss. */
  function handleFreeKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (freeCurrent.trim() === "") return;
    void commitFreeWord();
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

  // Back to the start screen without spending a Claude call. Only reachable by
  // quitting on the first sentence now, where there's nothing worth submitting.
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

  // The index rides along because it's what everything else keys off: where the
  // cursor is, and what was typed at each slot.
  const freeRows = Array.from(
    { length: Math.ceil(freeWords.length / FREE_COLUMNS) },
    (_, row) =>
      freeWords
        .slice(row * FREE_COLUMNS, (row + 1) * FREE_COLUMNS)
        .map((word, col) => ({ word, index: row * FREE_COLUMNS + col })),
  );

  // Row-major, padded with null so the board stays 6 by 10 even with two words.
  const wordRows = Array.from({ length: WORD_ROWS }, (_, row) =>
    Array.from(
      { length: WORD_COLUMNS },
      (_, col) => shownWeak[row * WORD_COLUMNS + col] ?? null,
    ),
  );


  // The list screens and the start screen sit at the top. Everything else stays
  // centered, so a sentence you're typing lands under your eyes. Loading holds
  // the start screen's position, since it's still the start screen on display.
  const cardClass =
    tab === "words"
      ? // Uncapped, unlike every other screen, so the board and the add-a-word
        // panel get the full window width. The top margin clears the tab bar,
        // which is absolute and so contributes no flow height of its own.
        "w-full self-start mt-16"
      : tab === "stats"
        ? // Stats reads like a page, not a prompt, so it starts top-left. Same
          // top margin as the other tabs, to clear the absolute tab bar.
          "mx-0 mt-16 mb-0 w-full max-w-[880px] self-start"
        : tab === "free"
          ? freePhase === "typing"
            ? // The board sizes itself to its widest row, so the card takes its
              // width from the board rather than the usual reading cap.
              "m-auto"
            : freePhase === "done"
              ? "m-auto w-full max-w-[880px]"
              : "mx-auto mt-48 mb-0 w-full max-w-[880px] self-start"
          : phase === "idle" || phase === "loading"
          ? // The start screen is two short lines; centering them leaves the
            // button floating in an empty page, so it sits high instead. The top
            // margin clears the tab bar and intro blurb, both absolute at top-7
            // and so contributing no flow height to push it down.
            "mx-auto mt-48 mb-0 w-full max-w-[880px] self-start"
          : // Centered, so the sentence you're typing lands under your eyes.
            // Auto margins rather than align-items, which clips the top of
            // anything taller than the viewport.
            "m-auto w-full max-w-[880px]";

  // Each mode says its own piece, and only while you're not typing: mid-sentence
  // it's one more thing on screen competing with the words. Off the typing
  // screen it's always there, so it can't go missing on the tab you came back to.
  const endTyping =
    tab === "practice" && phase === "typing"
      ? endSession
      : tab === "free" && freePhase === "typing"
        ? () => setFreePhase("done")
        : null;

  const intro =
    tab === "practice" && phase !== "typing"
      ? "Sentences written around the words you misspell most often. Type each one exactly as it appears, and at the end you get told what your mistakes have in common."
      : tab === "free" && freePhase !== "typing"
        ? "Common English words you haven't flagged yet, here to catch the ones you didn't know you were getting wrong. Type each word and press space; miss the same word three times and it joins your weak list."
        : null;

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
      {intro && <p className={INTRO}>{intro}</p>}

      {endTyping && (
        <button className={END_BUTTON} onClick={endTyping}>
          End session
        </button>
      )}

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
          className={tab === "free" ? TAB_ON : TAB_OFF}
          onClick={openFreeType}
        >
          Free Type
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
                  className="cursor-pointer rounded-[10px] border border-white px-20 py-9 text-[3.2rem] text-white no-underline hover:bg-white/8"
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
                {/* No box around it, just the line you're writing under the
                    one you're copying. Same face and size as the sentence, so
                    the two read as one block instead of a form. */}
                <input
                  key={index}
                  ref={inputRef}
                  className="w-full border-0 bg-transparent p-0 font-mono text-[1.9rem] text-white outline-none"
                  value={current}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
              </>
            )}

            {phase === "submitting" && <p>Checking your typing…</p>}

            {phase === "done" && analysis && (
              <div className="flex flex-col gap-7 leading-[1.6]">
                <h1 className="m-0 text-[2.4rem]">Session complete</h1>
                {/* self-start, or the flex row stretches and text buttons
                    render as full-width bars. */}
                <div className="flex gap-8 self-start">
                  <button
                    className={`${TEXT_BUTTON} underline underline-offset-4`}
                    onClick={startSession}
                  >
                    New session
                  </button>
                  <button
                    className={`${TEXT_BUTTON} underline underline-offset-4`}
                    onClick={() => setShowRecap(!showRecap)}
                  >
                    {showRecap ? "Hide stats" : "Show stats"}
                  </button>
                </div>
                {showRecap && (
                  <SessionRecap
                    words={results}
                    typing={analysis.typing}
                    patternSummary={analysis.pattern_summary}
                    newWords={analysis.new_words}
                  />
                )}
              </div>
            )}
          </>
        )}

        {tab === "free" && (
          <>
            {freePhase === "idle" && (
              <>
                <button
                  className="cursor-pointer rounded-[10px] border border-white px-20 py-9 text-[3.2rem] text-white no-underline hover:bg-white/8"
                  onClick={startFreeType}
                >
                  Start session
                </button>
                {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
              </>
            )}

            {freePhase === "loading" && (
              <>
                <p className="mt-0 mb-7 text-[2.4rem]">Loading words…</p>
                <div className="size-11 animate-[spin_0.8s_linear_infinite] rounded-full border-[3px] border-transparent border-t-white" />
              </>
            )}

            {freePhase === "typing" && (
              // Clicking anywhere on the board puts the cursor back, since the
              // input catching your keystrokes is off screen.
              <div onClick={() => freeInputRef.current?.focus()}>
                <div className={FREE_BOARD}>
                  {freeRows.map((row, rowIndex) => (
                    <div key={rowIndex} className="flex gap-x-[1ch]">
                      {row.map(({ word, index }) => (
                        <FreeWord
                          key={index}
                          word={word}
                          typed={
                            index === freeIndex
                              ? freeCurrent
                              : (freeAttempts[index] ?? null)
                          }
                          active={index === freeIndex}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                {/* Off screen on purpose: what you type is drawn into the board
                    itself, so a second copy of it in a box is just noise. */}
                <input
                  ref={freeInputRef}
                  className="sr-only"
                  value={freeCurrent}
                  onChange={(e) => setFreeCurrent(e.target.value)}
                  onKeyDown={handleFreeKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
              </div>
            )}

            {freePhase === "done" && (
              <div className="flex flex-col gap-7 leading-[1.6]">
                <h1 className="m-0 text-[2.4rem]">Free type finished</h1>
                {/* self-start, or the flex row stretches and text buttons
                    render as full-width bars. */}
                <div className="flex gap-8 self-start">
                  <button
                    className={`${TEXT_BUTTON} underline underline-offset-4`}
                    onClick={startFreeType}
                  >
                    Restart session
                  </button>
                  <button
                    className={`${TEXT_BUTTON} underline underline-offset-4`}
                    onClick={() => setShowFreeStats(!showFreeStats)}
                  >
                    {showFreeStats ? "Hide stats" : "Show stats"}
                  </button>
                </div>
                {showFreeStats && (
                  <>
                    <p className="m-0 text-[1.3rem]">
                      {freeTypedCount} typed, {freeAdded.length} added to your
                      list.
                    </p>
                    {freeAdded.length > 0 && (
                      <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[1.3rem]">
                        {freeAdded.map((word) => (
                          <li key={word}>{word}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {tab === "stats" && (
          <>
            {stats === null && !error && <p>Loading your stats…</p>}

            {stats && (
              <div className="flex flex-col gap-8">
                <section>
                  {/* Bigger than the HEADING used by the sections below it:
                      this one labels the whole tab, not a section, and says the
                      numbers under it are all-time rather than per-session. */}
                  <h2 className="mt-0 mb-2.5 text-[2.6rem] font-semibold">
                    Total
                  </h2>
                  <div className="flex gap-12">
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
              <section>
                {/* w-max takes its width from the widest child (the board row),
                    so the heading and blurb sit flush with the board's left edge
                    while the whole block stays centred in the window. */}
                <div className="mx-auto w-max max-w-full">
                  <h2 className="mt-0 mb-2 text-[1.8rem] font-semibold">
                    Weak Words{" "}
                    <span className="font-mono">
                      ({weak.length}/{WORD_SLOTS})
                    </span>
                  </h2>
                  {/* Broken explicitly: the line width here comes from the
                      board, so wrapping would put the breaks wherever it lands.
                      WORD_SLOTS rather than a literal 60, so the sentence can't
                      drift from the grid it describes. */}
                  <p className="mt-0 mb-6 text-[1.3rem]">
                    These are words you need to practice.
                    <br />
                    Every practice session builds its sentences out of them, so
                    don't add words you're already confident in.
                    <br />
                    {WORD_SLOTS} words max.
                  </p>

                  <div className="flex items-start gap-16">
                  {/* border-separate keeps each cell its own rounded box
                      instead of collapsing into shared grid lines. */}
                  <table
                    className={`${WORD_TABLE_WIDTH} table-fixed border-separate border-spacing-2 font-mono text-[1.15rem]`}
                  >
                    <tbody>
                      {wordRows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((entry, colIndex) => (
                            <td
                              key={colIndex}
                              className={`rounded-md border px-2 py-3 text-center whitespace-nowrap ${
                                entry
                                  ? // The same red a missed word gets mid-session.
                                    // Empty slots stay dim: spare room isn't
                                    // something you're getting wrong.
                                    "border-[#ff7a70] text-[#ff7a70]"
                                  : "border-[#4a4f4c]"
                              }`}
                              aria-hidden={entry ? undefined : "true"}
                            >
                              {entry ? entry.word : " "}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Fixed rather than w-max: at w-max the panel came out 409px
                      and the row overflowed the window, clipping words off the
                      board. The board can't shrink, so the panel gives. */}
                  <div className="w-[230px] shrink-0 grow-0">
                    <p className="mt-0 mb-2.5 text-[1.9rem]">
                      Add words you want to practice
                    </p>

                    {/* A form, so Enter submits without a key handler. */}
                    <form
                      className="flex flex-col gap-2.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        submitWord();
                      }}
                    >
                      <input
                        className="w-full rounded-md border border-[#4a4f4c] bg-[#1e2220] px-5 py-3 font-mono text-[1.4rem] text-white outline-none placeholder:text-[#7d827e] focus:border-white"
                        value={newWord}
                        onChange={(e) => setNewWord(e.target.value)}
                        placeholder="type any word"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                      {/* The one green thing in the app: it's the only button
                          that writes to your word list, and everything around it
                          is a plain white outline. */}
                      <button
                        type="submit"
                        className="cursor-pointer rounded-md border border-[#7fb069] px-6 py-3 text-[1.9rem] text-[#7fb069] no-underline hover:bg-[#7fb069]/12"
                      >
                        Add
                      </button>
                    </form>

                    {wordNote && (
                      <p className="mt-0 mb-4 text-[1.3rem]">{wordNote}</p>
                    )}
                  </div>
                  </div>
                </div>
              </section>
            )}

            {error && <p className="mt-4 text-[#ff7a70]">{error}</p>}
          </>
        )}
      </div>
    </>
  );
}
