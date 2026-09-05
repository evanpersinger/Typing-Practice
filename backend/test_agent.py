"""A stand-in for `agent`, used by the testing profile.

Same function, same return type, no network. The real agent spends 10-30
seconds on Claude at session start, which is fine when you're practicing and
miserable when you're clicking through the UI for the tenth time to check a
button.

The sentences are fixed rather than generated, so a testing session is also
repeatable: the same words come up every time, and you always know which ones
you're about to misspell on purpose.
"""

from __future__ import annotations

from backend.agent import Drill, GeneratedDrills

# Short on purpose. You're exercising the app, not practicing.
DRILLS: list[tuple[str, list[str]]] = [
    ("Keep the two files separate.", ["separate"]),
    ("That is definitely the wrong answer.", ["definitely"]),
    ("A vector is not a variable.", ["vector", "variable"]),
    ("Did you receive the invoice?", ["receive"]),
    ("This is a rare occurrence.", ["occurrence"]),
    ("The itinerary is available now.", ["itinerary", "available"]),
    ("Regular maintenance is necessary.", ["maintenance", "necessary"]),
    ("She spelled it incorrectly again.", ["incorrectly"]),
    ("Explain the difference to me.", ["difference"]),
    ("Too much caffeine is a problem.", ["caffeine"]),
]


def generate_drills(words: list[str] | None = None, count: int = 9) -> GeneratedDrills:
    """The canned set. `words` is ignored: there's no weak-word list to serve."""
    return GeneratedDrills(
        drills=[
            Drill(sentence=sentence, target_words=targets)
            for sentence, targets in DRILLS[:count]
        ]
    )
