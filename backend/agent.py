"""The two Claude calls that run at the edges of a session.

Nothing here touches the keystroke loop — the app only calls these at session
start (generate practice sentences) and session end (find the typo pattern and
suggest new words). Swap MODEL to change which Claude model both calls use.
"""

from __future__ import annotations

from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")  # picks up ANTHROPIC_API_KEY

MODEL = "claude-opus-4-8"  # one place to change the model for both calls

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    """Build the client on first use so the server can boot without a key set."""
    global _client
    if _client is None:
        _client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment / .env
    return _client


# --- structured output shapes (Claude is forced to return exactly these) ---

class Drill(BaseModel):
    sentence: str
    target_words: list[str]


class GeneratedDrills(BaseModel):
    drills: list[Drill]


class WordSuggestion(BaseModel):
    word: str
    reason: str


class Analysis(BaseModel):
    pattern_summary: str
    new_words: list[WordSuggestion]


# --- session start: generate practice sentences ---

def generate_drills(words: list[str], count: int = 6) -> GeneratedDrills:
    joined = ", ".join(words)
    prompt = (
        f"Write {count} short, natural English sentences for a typing-practice app. "
        f"Weave in these words the user commonly misspells, spread across the set so "
        f"each word appears at least once: {joined}. "
        "Keep the sentences everyday and easy to read, 6-14 words each. "
        "For each sentence, list which of the target words it contains."
    )
    response = _get_client().messages.parse(
        model=MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        output_format=GeneratedDrills,
    )
    return response.parsed_output


# --- session end: find the pattern behind the misses ---

def analyze_session(misses: list[dict]) -> Analysis:
    """`misses` is a list of {"word": target, "typed": what_the_user_typed}."""
    if not misses:
        return Analysis(pattern_summary="No misses this session — clean run.", new_words=[])

    lines = "\n".join(f"- target '{m['word']}' typed as '{m['typed']}'" for m in misses)
    prompt = (
        "A user is practicing typing to break habitual misspellings. Here are the "
        "words they got wrong this session, with what they actually typed:\n"
        f"{lines}\n\n"
        "In one or two plain sentences, describe the pattern behind these mistakes "
        "(e.g. letter transposition, dropped double letters, ie/ei swaps). Then "
        "suggest up to 5 NEW words (not already in the list above) that fit the same "
        "weakness and would be good practice, each with a short reason."
    )
    response = _get_client().messages.parse(
        model=MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        output_format=Analysis,
    )
    return response.parsed_output
