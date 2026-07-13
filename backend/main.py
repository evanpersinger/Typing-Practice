"""
FastAPI app wiring the local trainer together.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend import agent, db

SEED_PATH = Path(__file__).resolve().parent.parent / "seed_words.txt"


@asynccontextmanager
async def lifespan(app: FastAPI):
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
def get_drills():
    """Session start: pick the weakest words and generate sentences for them."""
    words = db.get_drilling_words(limit=10) + db.get_mastered_sample(2)
    if not words:
        return {"words": [], "drills": []}
    generated = agent.generate_drills(words)
    return {"words": words, "drills": [d.model_dump() for d in generated.drills]}


@app.get("/stats")
def get_stats():
    """Everything the stats tab shows: per-word counters plus typing speed."""
    return {"words": db.get_all_words(), "typing": db.get_typing_stats()}


@app.post("/results")
def submit_results(payload: ResultsPayload):
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

    analysis = agent.analyze_session(misses)

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
    }
