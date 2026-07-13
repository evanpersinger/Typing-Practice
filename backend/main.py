"""
FastAPI app wiring the local trainer together.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend import agent, db, fake_agent

SEED_PATH = Path(__file__).resolve().parent.parent / "seed_words.txt"


def agent_for(profile: str):
    """Testing gets canned sentences and a canned analysis: same shapes, no
    Claude, so a session starts instantly instead of after a 20-second wait."""
    return fake_agent if profile == "testing" else agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Both worlds get built at boot, so picking "testing" for the first time
    # lands on a seeded word list instead of an empty one.
    for name in db.PROFILES:
        db.use_profile(name)
        db.init_db()
        db.seed_from_file(SEED_PATH)
        db.render_markdown()
    yield


app = FastAPI(title="Typing Practice", lifespan=lifespan)

# The Vite dev server runs on 5173 and calls this backend on 8000.
# allows frontend to talk to the backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/drills")
def get_drills(profile: Profile):
    """Session start: pick the weakest words and generate sentences for them.

    Testing skips the word list entirely. There's nothing to be weak at in a
    profile you throw away, so it goes straight to the canned sentences.
    """
    if profile == "testing":
        generated = fake_agent.generate_drills()
        return {"words": [], "drills": [d.model_dump() for d in generated.drills]}

    # Roughly one target per sentence. Cram more in and the generator has to
    # double them up, which is what makes a practice sentence read like one.
    words = db.get_drilling_words(limit=7) + db.get_mastered_sample(1)
    if not words:
        return {"words": [], "drills": []}
    generated = agent.generate_drills(words)
    return {"words": words, "drills": [d.model_dump() for d in generated.drills]}


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

    db.render_markdown()
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
