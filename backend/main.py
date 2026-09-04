"""
FastAPI app wiring the local trainer together.
"""

from __future__ import annotations

import random
import re
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from wordfreq import top_n_list

from backend import agent, db, test_agent


def agent_for(profile: str):
    """Testing gets canned sentences and a canned analysis: same shapes, no
    Claude, so a session starts instantly instead of after a 20-second wait."""
    return test_agent if profile == "testing" else agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Both worlds get built at boot, so picking "testing" for the first time
    # lands on a seeded word list instead of an empty one.
    for name in db.PROFILES:
        db.use_profile(name)
        db.init_db()
        for path in db.active_profile().seeds:
            db.seed_from_file(path)
    yield


# No CORS middleware: the Vite dev server proxies /api through to here, so every
# request arrives same-origin as far as the browser is concerned. The frontend's
# port is no longer this module's business.
app = FastAPI(title="Typing Practice", lifespan=lifespan)


async def use_profile(x_profile: Annotated[str, Header()] = db.DEFAULT_PROFILE) -> str:
    """Bind this request to the profile the frontend picked on the way in.

    Async on purpose: it has to run in the request's own context for the
    contextvar to still be set by the time the endpoint reads it.
    """
    try:
        db.use_profile(x_profile)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown profile: {x_profile}")
    return x_profile


# Every endpoint takes this. There is no way to reach the database without
# having said which world you're in.
Profile = Annotated[str, Depends(use_profile)]


# One word and nothing else: no spaces, commas, periods or digits. The
# apostrophe and hyphen are allowed because they appear inside real words
# ("can't", "well-known"), but not at the start, so punctuation alone can't get
# through. Capitals aren't rejected — db.add_word lowercases, same as it does
# for the seed files, so "Necessary" is stored as "necessary" rather than
# bounced back at you.
WORD_PATTERN = re.compile(r"^[a-z][a-z'-]*$")
MAX_WORD_LENGTH = 40


# Free Type draws from the most common English words by measured usage, not from
# a dictionary and not from a list anybody hand-picked. Short words are dropped,
# nobody misspells "have". Reusing WORD_PATTERN is what guarantees a word this
# serves can survive the round trip back through POST /words.
MIN_FREE_TYPE_LENGTH = 5
FREE_TYPE_BATCH = 200
FREE_TYPE_POOL = [
    word
    for word in top_n_list("en", 2000, ascii_only=True)
    if len(word) >= MIN_FREE_TYPE_LENGTH and WORD_PATTERN.match(word)
]


class WordResult(BaseModel):
    word: str
    typed: str
    correct: bool


class DrillResult(BaseModel):
    sentence: str
    typed: str
    duration_ms: int = 0
    words: list[WordResult]


class ResultsPayload(BaseModel):
    results: list[DrillResult]


class WordPayload(BaseModel):
    word: str


@app.get("/drills")
def get_drills(profile: Profile):
    """Session start: pick the weakest words and generate sentences for them.

    Testing skips the word list entirely. There's nothing to be weak at in a
    profile you throw away, so it goes straight to the canned sentences.
    """
    if profile == "testing":
        generated = test_agent.generate_drills()
        return {"words": [], "drills": [d.model_dump() for d in generated.drills]}

    # Roughly one target per sentence. Cram more in and the generator has to
    # double them up, which is what makes a practice sentence read like one.
    words = db.get_drilling_words(limit=7) + db.get_mastered_sample(1)
    if not words:
        return {"words": [], "drills": []}
    generated = agent.generate_drills(words)
    return {"words": words, "drills": [d.model_dump() for d in generated.drills]}


@app.get("/free-words")
def get_free_words(profile: Profile):
    """Free Type: common words to fish for weaknesses you don't know about yet.

    Words already on your list are filtered out. Re-drilling a known weak word is
    what Practice is for; this mode is only looking for new ones. Nothing here
    writes: a word only earns its place by being missed three times, and the
    frontend adds it through POST /words like any other.
    """
    known = {row["word"] for row in db.get_all_words()}
    pool = [word for word in FREE_TYPE_POOL if word not in known]
    return {"words": random.sample(pool, min(FREE_TYPE_BATCH, len(pool)))}


@app.post("/words")
def add_practice_word(payload: WordPayload, profile: Profile):
    """Add a word you want to practice, from the Words tab.

    Validation lives here rather than in db.py because the rules are about what
    a person is allowed to type into a box, and the answer to breaking one is an
    HTTP 400. Storage stays unopinionated: seeded and agent-suggested words go
    in through the same door without passing this check.
    """
    word = payload.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="Type a word first.")
    if len(word) > MAX_WORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Keep it under {MAX_WORD_LENGTH} characters.",
        )
    if not WORD_PATTERN.match(word):
        raise HTTPException(
            status_code=400,
            detail="One word only — letters, apostrophes and hyphens.",
        )

    # `added` is False when the word was already tracked. Not an error: you
    # asked for it to be on the list and it is, so the UI says so and moves on.
    return {"word": word, "added": db.add_word(word, source="user")}


@app.get("/stats")
def get_stats(profile: Profile):
    """Everything the stats tab shows: per-word counters plus typing speed."""
    return {"words": db.get_all_words(), "typing": db.get_typing_stats()}


@app.post("/results")
def submit_results(payload: ResultsPayload, profile: Profile):
    """Session end: bookkeeping in code, pattern-finding via the agent."""
    # One POST is one sitting, so the session boundary is already here in the
    # request. Nothing has to infer it from timestamps later.
    session_id = db.start_session()

    misses: list[dict] = []
    for drill in payload.results:
        db.record_drill(drill.sentence, drill.typed, drill.duration_ms, session_id)
        for word in drill.words:
            db.record_result(word.word, word.typed, word.correct, session_id)
            if not word.correct:
                misses.append({"word": word.word, "typed": word.typed})

    analysis = agent_for(profile).analyze_session(misses)

    for suggestion in analysis.new_words:
        db.add_word(suggestion.word, source="agent")

    db.finish_session(
        session_id,
        analysis.pattern_summary,
        [s.model_dump() for s in analysis.new_words],
    )
    db.write_session_transcript(
        [d.model_dump() for d in payload.results],
        analysis.pattern_summary,
        [s.model_dump() for s in analysis.new_words],
    )
    return {
        "pattern_summary": analysis.pattern_summary,
        "new_words": [s.model_dump() for s in analysis.new_words],
        "typing": db.get_typing_stats(session_id),
    }


@app.get("/sessions")
def list_sessions(profile: Profile):
    """Every past session, most recent first, for the Stats tab dropdown."""
    return {"sessions": db.list_sessions()}


@app.get("/sessions/{session_id}")
def get_session(session_id: int, profile: Profile):
    """One past session's full recap, same shape the results screen shows live."""
    detail = db.get_session_detail(session_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="session not found")
    return detail
