# Typing Practice

A typing trainer that only drills the words *you* get wrong.

It keeps a list of words you misspell, asks Claude to write practice sentences
around them, grades what you type, and then asks Claude what the pattern behind
your typos was. Words you keep missing stay in rotation. Words you get right ten
times in a row graduate out. New words get added when Claude spots a weakness.

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

Testing exists so you can click through the UI without paying for two Claude
calls and waiting half a minute each time. It always serves the same ten
sentences, so you know exactly which words you're about to misspell on purpose.

The profile travels as an `X-Profile` header on every request. The backend binds
it to the request and every read and write follows it from there.

## A session

1. **Start.** `GET /drills` picks your 7 weakest words still in rotation, plus 1
   graduated word as a surprise re-test, and Claude writes 10 sentences using
   them. Roughly one target word per sentence.
2. **Type.** One sentence at a time, Enter to advance. A hidden clock runs from
   your first keystroke (not from when the sentence appeared) and pauses if you
   wander off to the Stats tab, so the timing reflects typing and nothing else.
3. **End.** `POST /results` sends every sentence you finished. The backend
   records the drill, updates each target word's attempts / misses / streak, and
   asks Claude what pattern connects the misses. Suggested new words are added
   to your list. A transcript is written to `sessions/`.

**End session** quits early and keeps only the sentences you pressed Enter on.
The half-typed one on screen is dropped: that's an interruption, not a
misspelling, and grading it would put a word back in rotation for no reason.

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

SQLite, four tables, all in `backend/db.py`:

- `words` — one row per tracked word: `attempts`, `misses`, `streak`, `status`
  (`drilling` / `mastered`), `source` (`seed` / `agent` / `session`).
- `attempts` — one row per target word per sentence, including **what you
  actually typed**. This is where the misspellings themselves live.
- `drills` — one row per sentence: the prompt, your raw text, and how long you
  took. Words-per-minute comes from here.
- `sessions` — one row per sitting. `attempts` and `drills` both point at it.

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
  after every drill: prompt, what you typed, and the pattern Claude found.
  A readable history, not just database rows. Gitignored, personal and testing
  respectively.

```
backend/
  main.py        FastAPI: /drills, /stats, /results, /words. Picks the profile per request.
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
- **Only target words are graded.** Your raw text for every sentence is stored
  in `drills.typed`, so the other words could be graded later, retroactively.
