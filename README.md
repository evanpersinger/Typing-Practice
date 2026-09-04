# Typing Practice

A typing trainer that only drills the words *you* get wrong.

It keeps a list of words you misspell, asks a model to write practice sentences
around them, grades what you type, and then asks the model what the pattern
behind your typos was. Words you keep missing stay in rotation. Words you get
right ten times in a row graduate out. New words are added when you misspell
them, not when a model guesses you might.

## Running it

```
make install
```

Then, in two terminals:

```
make backend
make frontend
```

Open the URL the frontend dev server prints, not the backend one. Needs an API
key in `.env` at the repo root, see below. Both ports are set in the `Makefile`.

## Providers

The two model calls run against either Anthropic or OpenAI. `LLM_PROVIDER` in
`.env` picks which, and it defaults to `anthropic`, so leaving it out keeps the
behaviour this app has always had.

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
LLM_PROVIDER=openai
```

Only the key for the provider you're actually using has to be set. Pick one
whose key is missing and the server names the variable it wants, rather than
failing halfway through a session with whatever the SDK throws.

The model per provider lives in `MODELS` in `backend/agent.py`. Both prompts are
byte-identical either way; the only thing that differs is the SDK call that
forces the structured output, and that branch lives in `_parse()` and nowhere
else.

The OpenAI side runs at reasoning effort `high`. That is not a preference. At
lower effort the small models write the *misspelling* into the practice
sentence, sometimes with the correct form in brackets after it, which is the
exact opposite of what this app is for. High effort spends a lot more reasoning
tokens, and those bill as output, so a cheap model here is less cheap than the
price list suggests.

The frontend proxies `/api` to the backend (set in `frontend/vite.config.ts`),
so the browser only ever talks to one port and there's no CORS to configure.
That proxy is dev-only: a real deployment would need a reverse proxy in front.

## Profiles

The app asks which profile you're in before it does anything, and it asks every
time you load the page. Nothing is remembered, on purpose.

| | Personal | Testing |
|---|---|---|
| database | `typing.db` | `typing_test.db` |
| transcripts | `sessions/` | `sessions_test/` |
| sentences | written by the model, from your weak words | canned, fixed (`backend/test_agent.py`) |
| analysis | the model | canned |
| session start | 10-30s | instant |

Separate files, not a flag on a row. Test data cannot reach your real numbers
even if something upstream is broken.

Testing exists so you can click through the UI without paying for two model
calls and waiting half a minute each time. It always serves the same ten
sentences, so you know exactly which words you're about to misspell on purpose.

The profile travels as an `X-Profile` header on every request. The backend binds
it to the request and every read and write follows it from there.

## A session

1. **Start.** `GET /drills` picks your 7 weakest words still in rotation, plus 1
   graduated word as a surprise re-test, and the model writes 10 sentences using
   them. Roughly one target word per sentence.
2. **Type.** One sentence at a time, Enter to advance. A hidden clock runs from
   your first keystroke (not from when the sentence appeared) and pauses if you
   wander off to the Stats tab, so the timing reflects typing and nothing else.
3. **End.** `POST /results` sends every sentence you finished. The backend
   records the drill, updates each target word's attempts / misses / streak, and
   asks the model what pattern connects the misses. It also compares every
   *other* word in each sentence against what you typed, see **Earning a place
   on the list**. A transcript is written to `sessions/`.

**End session** quits early and keeps only the sentences you pressed Enter on.
The half-typed one on screen is dropped: that's an interruption, not a
misspelling, and grading it would put a word back in rotation for no reason.

## Free Type

The **Free Type** tab is the other way in. It serves a board of 60 common
English words, ten rows of six, drawn by measured usage frequency from
`wordfreq` rather than a dictionary or a list anybody hand-picked. Words already
on your list are filtered out: re-drilling a word you've already flagged is what
Practice is for, this mode is looking for the ones you don't know about.

You type each word and press space. The word you're on is drawn character by
character with your attempt over it, so a letter you got wrong turns red where
you got it wrong. Miss a word and it's dealt back into the board five words
later, rather than repeating immediately, so you're recalling it instead of
copying the line above. Miss the same word three times in one sitting and it
joins your weak list.

No model call, no timing, no score. Nothing here is recorded except a word that
earns its way onto the list.

## Earning a place on the list

Three ways a word gets tracked, and none of them is a model deciding for you.

1. **You add it**, from the Words tab.
2. **You misspell it three times in Free Type**, within one sitting.
3. **You misspell it three times in practice sentences**, across as many
   sessions as it takes. Every word in a sentence is compared against what you
   typed, not just the target words. A mismatch counts only if the word is five
   or more characters and you were within two edits of it, so `seperate` for
   `separate` counts and typing `same` where the sentence said `two` doesn't:
   that's a different word, not a misspelling. The running count lives in the
   `misspellings` table and survives across sessions, because ten sentences is
   nowhere near enough to get the same word wrong three times.

The model used to suggest up to five new words per session and add them
directly. That's gone. `get_drilling_words` ranks never-attempted words above
everything else, so a suggested word outranked every word you actually kept
getting wrong until you'd typed it once, and five a session was enough to fill
most of the next session with guesses. The model still tells you what your
mistakes have in common, which is the useful half.

## Weak words

The **Words** tab is a fixed board of 60 cells, six across by ten down, holding
the words still in rotation in alphabetical order. The empty cells are the point
as much as the full ones: the shape of the board is how much backlog you have,
readable without counting. The heading gives the same thing as a number.

You can also add a word yourself. `POST /words` lowercases it and takes letters,
apostrophes and hyphens only, up to 40 characters, so a phrase or a sentence gets
rejected rather than stored as one unpronounceable "word". Duplicates aren't
merely avoided, they're impossible: `words.word` is `UNIQUE` and the insert is
`OR IGNORE`, so adding a word twice is a silent no-op. The response says whether
the word was new, which is the only reason that route returns anything.

Words added this way start with no attempts, so they sort straight to the top of
the weakest list and show up in your next session.

## Data

SQLite, all of it in `backend/db.py`:

- `words` — one row per tracked word: `attempts`, `misses`, `streak`, `status`
  (`drilling` / `mastered`), `source` (`seed` / `user` / `performance` /
  `session`, plus `agent` on rows that predate the model losing that power).
- `misspellings` — the running count for a word that isn't tracked yet, on its
  way to three strikes. Rows are deleted the moment the word graduates onto
  `words`, so this table is only ever a waiting room.
- `attempts` — one row per target word per sentence, including **what you
  actually typed**. This is where the misspellings themselves live.
- `drills` — one row per sentence: the prompt, your raw text, and how long you
  took. Words-per-minute comes from here.
- `sessions` — one row per sitting. `attempts` and `drills` both point at it.
- `session_new_words` — the words a session put on your list, with the reason.

Ten clean hits in a row graduates a word to `mastered`. One miss puts it
straight back into `drilling`.

**wpm** is total characters over total time, five characters to a "word", the
usual typing-test convention. Not the average of per-sentence rates, which would
let a four-word sentence count as much as a long one.

## Layout

- `backend/` — FastAPI server. `main.py` wires up the routes, `db.py`
  owns all storage and arithmetic, `agent.py`/`test_agent.py` own the model calls.
  Nothing else in the app touches SQLite or a model directly.
- `frontend/` — React + Vite single-page app. Talks to the backend
  through the `/api` proxy; no server-side rendering, no router, one page.
  Styled with Tailwind, so there's no stylesheet to speak of: `index.css` is
  the Tailwind import, the page background, and one keyframe.
- `sessions/` / `sessions_test/` — one markdown transcript per sitting, written
  after every drill: prompt, what you typed, and the pattern the model found.
  A readable history, not just database rows. Gitignored, personal and testing
  respectively.

```
backend/
  main.py        FastAPI: /drills, /free-words, /stats, /results, /words, /sessions.
  db.py          All storage and all arithmetic. The agent never does math.
  agent.py       The two model calls: write sentences, find the pattern.
  test_agent.py  Same two functions, canned. Used by the testing profile.
frontend/src/
  App.tsx        The whole UI: profile picker, practice, results, stats, words.
  api.ts         The fetch calls, and the profile header.
  grade.ts       Aligns typed words to expected words and marks the targets.
  index.css      Tailwind import, page background, one keyframe. That's all.
seed_words.txt          Example word list, committed. Baseline for both profiles.
seed_words_personal.txt Your real word list, gitignored. Layers on top, personal only.
```

Loaded on boot, duplicates ignored. A fresh clone's personal profile isn't
empty: it gets the example list until `seed_words_personal.txt` exists.

## Known rough edges

- **Grading is positional.** `grade.ts` matches your words to the expected words
  by index. Drop or insert a word mid-sentence and everything after it shifts,
  so correctly spelled words can be marked wrong. Fine for copy-typing, and it
  only affects the target words, which are a couple per sentence.
- **Pasting works.** Nothing stops you pasting the sentence, which records
  perfect accuracy and an absurd wpm.
- **`best_wpm` is an all-time max**, so one bad row poisons it permanently.
- **Only target words are scored.** The other words in a sentence are checked
  for misspellings (see above) but never recorded in `attempts`, so they have no
  accuracy or streak of their own until they earn a place on the list. Your raw
  text is in `drills.typed` either way, so that could be filled in retroactively.
