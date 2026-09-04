"""The two model calls that run at the edges of a session.

Nothing here touches the keystroke loop, the app only calls these at session
start (generate practice sentences) and session end (find the typo pattern and
suggest new words). Set LLM_PROVIDER in .env to pick which provider runs them.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TypeVar

from anthropic import Anthropic
from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")  # picks up LLM_PROVIDER and both API keys

"""
Model each provider uses for both calls:

Anthropic (latest generation):
claude-opus-4-6            Opus 4.6  - most advance, most expensive
claude-sonnet-5            Sonnet 5  - strong all-rounder, 
claude-haiku-4-5-20251001  Haiku 4.5 - cheapest model

OpenAI:
gpt-5             full model, better prose, slower and pricier
gpt-5-mini        middle option, closest match to Haiku
gpt-5-nano        smallest and cheapest
"""

MODELS = {
    "anthropic": "claude-haiku-4-5-20251001", # haiku 4.5
    "openai": "gpt-5-nano", # gpt 5-nano
}

# The env var each provider's SDK reads its key from. Checked up front so a
# missing key says which one is missing, instead of surfacing as an SDK error
# halfway through a session.
KEY_VARS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
}

# Anthropic stays the default, so an existing .env keeps working untouched.
PROVIDER = os.getenv("LLM_PROVIDER", "anthropic").strip().lower()

_client: Anthropic | OpenAI | None = None


def _get_client() -> Anthropic | OpenAI:
    """Build the client on first use so the server can boot without a key set."""
    global _client
    if _client is None:
        if PROVIDER not in MODELS:
            raise RuntimeError(
                f"LLM_PROVIDER is {PROVIDER!r}, expected one of {sorted(MODELS)}."
            )
        if not os.getenv(KEY_VARS[PROVIDER]):
            raise RuntimeError(
                f"LLM_PROVIDER is {PROVIDER!r} but {KEY_VARS[PROVIDER]} is not set. "
                "Add it to .env at the repo root."
            )
        # Each SDK reads its own key from the environment.
        _client = Anthropic() if PROVIDER == "anthropic" else OpenAI()
    return _client


T = TypeVar("T", bound=BaseModel)


def _parse(prompt: str, max_tokens: int, output_format: type[T]) -> T:
    """One structured-output call, forced into `output_format`.

    The prompts are identical whichever provider is running, only the two SDKs'
    parse methods differ, so the branch lives here and nowhere else.
    """
    client = _get_client()
    model = MODELS[PROVIDER]

    if isinstance(client, Anthropic):
        response = client.messages.parse(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
            output_format=output_format,
        )
        return response.parsed_output

    # High effort is what stops the smaller models writing the misspelling into
    # the practice sentence, and the headroom covers what that reasoning costs:
    # these models spend output tokens thinking before they write anything, so
    # the cap that's comfortable for Claude comes back empty.
    response = client.responses.parse(
        model=model,
        max_output_tokens=max_tokens + 8000,
        reasoning={"effort": "high"},
        input=prompt,
        text_format=output_format,
    )
    if response.output_parsed is None:
        raise RuntimeError(f"{model} returned no parsed output (likely a refusal).")
    return response.output_parsed


# structured output shapes (the model is forced to return exactly these)

class Drill(BaseModel):
    sentence: str
    target_words: list[str]


class GeneratedDrills(BaseModel):
    drills: list[Drill]


class Analysis(BaseModel):
    pattern_summary: str


# session start: generate practice sentences

def generate_drills(words: list[str], count: int = 10) -> GeneratedDrills:
    joined = ", ".join(words)
    prompt = (
        f"Write {count} English typing-practice items of mixed length and form: "
        "some short phrases (4-7 words), some medium sentences (8-13), and some longer "
        "ones (13-18). Vary them so the set feels random. "
        f"Weave in these words the user commonly misspells, spread across the set so "
        f"each word appears at least once: {joined}. "
        "Keep them everyday and easy to read. "
        "For each item, list which of the target words it contains."
    )
    return _parse(prompt, 1000, GeneratedDrills)


# session end: find the pattern behind the misses
def analyze_session(misses: list[dict]) -> Analysis:
    """`misses` is a list of {"word": target, "typed": what_the_user_typed}.

    The model reads the misses and nothing else. It used to also nominate words
    to practice next, which is a guess about words you have never typed, and
    get_drilling_words ranks an unattempted word above every word you actually
    keep getting wrong. Words earn their place by being misspelled now.
    """
    if not misses:
        return Analysis(pattern_summary="No misses this session, clean run.")

    lines = "\n".join(f"- target '{m['word']}' typed as '{m['typed']}'" for m in misses)
    prompt = (
        "A user is practicing typing to break habitual misspellings. Here are the "
        "words they got wrong this session, with what they actually typed:\n"
        f"{lines}\n\n"
        "In one or two plain sentences, describe the pattern behind these mistakes "
        "(e.g. letter transposition, dropped double letters, ie/ei swaps)."
    )
    return _parse(prompt, 1500, Analysis)
