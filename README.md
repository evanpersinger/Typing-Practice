# Typing Practice

A typing trainer that only drills the words *you* get wrong.

It keeps a list of words you misspell, asks Claude to write practice sentences
around them, grades what you type, and then asks Claude what the pattern behind
your typos was. Words you keep missing stay in rotation. Words you get right ten
times in a row graduate out. New words get added when Claude spots a weakness.

## Running it

Backend (port 8000):

```
uv sync
uv run uvicorn backend.main:app --reload
```

Frontend (port 5173):

```
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173/. Needs `ANTHROPIC_API_KEY` in `.env` at the
repo root.

## Profiles

The app asks which profile you're in before it does anything, and it asks every
time you load the page. Nothing is remembered, on purpose.

| | Personal | Testing |
|---|---|---|
| database | `typing.db` | `typing_test.db` |
| word list | `weak_words.md` | `weak_words_test.md` |
| transcripts | `sessions/` | `sessions_test/` |
| sentences | written by Claude, from your weak words | canned, fixed (`backend/fake_agent.py`) |
| analysis | Claude | canned |
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

`weak_words.md` is rendered from the database after every session. It's a view,
not a source: edit it and you'll just lose your changes.

**wpm** is total characters over total time, five characters to a "word", the
usual typing-test convention. Not the average of per-sentence rates, which would
let a four-word sentence count as much as a long one.

## Layout

```
backend/
  main.py        FastAPI: /drills, /stats, /results. Picks the profile per request.
  db.py          All storage and all arithmetic. The agent never does math.
  agent.py       The two Claude calls: write sentences, find the pattern.
  fake_agent.py  Same two functions, canned. Used by the testing profile.
frontend/src/
  App.tsx        The whole UI: profile picker, practice, results, stats.
  api.ts         The three fetch calls, and the profile header.
  grade.ts       Aligns typed words to expected words and marks the targets.
seed_words.txt   Starting word list. Loaded on boot, duplicates ignored.
```

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
