"""FastAPI app wiring the local trainer together.

Run from the project root:
    uvicorn backend.main:app --reload
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Result(BaseModel):
    word: str
    typed: str
    correct: bool


class ResultsPayload(BaseModel):
    results: list[Result]


@app.get("/drills")
def get_drills():
    """Session start: pick the weakest words and generate sentences for them."""
    words = db.get_drilling_words(limit=10) + db.get_mastered_sample(2)
    if not words:
        return {"words": [], "drills": []}
    generated = agent.generate_drills(words)
    return {"words": words, "drills": [d.model_dump() for d in generated.drills]}


@app.post("/results")
def submit_results(payload: ResultsPayload):
    """Session end: bookkeeping in code, pattern-finding via the agent."""
    for result in payload.results:
        db.record_result(result.word, result.typed, result.correct)

    misses = [
        {"word": r.word, "typed": r.typed} for r in payload.results if not r.correct
    ]
    analysis = agent.analyze_session(misses)

    for suggestion in analysis.new_words:
        db.add_word(suggestion.word, source="agent")

    db.render_markdown()
    return {
        "pattern_summary": analysis.pattern_summary,
        "new_words": [s.model_dump() for s in analysis.new_words],
    }
