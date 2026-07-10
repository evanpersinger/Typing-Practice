"""SQLite storage for the typing trainer.

This is the source of truth for word stats. `weak_words.md` is a human-readable
view rendered from here, and the agent never does the arithmetic — the plain
functions below own attempts / misses / streak / graduation.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "typing.db"
MD_PATH = BASE_DIR / "weak_words.md"
SESSIONS_DIR = BASE_DIR / "sessions"

# Clean hits in a row before a word graduates from "drilling" to "mastered".
MASTERY_STREAK = 10


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS words (
                id        INTEGER PRIMARY KEY,
                word      TEXT UNIQUE NOT NULL,
                attempts  INTEGER NOT NULL DEFAULT 0,
                misses    INTEGER NOT NULL DEFAULT 0,
                streak    INTEGER NOT NULL DEFAULT 0,
                status    TEXT NOT NULL DEFAULT 'drilling',
                source    TEXT NOT NULL DEFAULT 'seed',
                last_seen TEXT
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id        INTEGER PRIMARY KEY,
                word      TEXT NOT NULL,
                typed     TEXT NOT NULL,
                correct   INTEGER NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )


def add_word(word: str, source: str = "seed") -> None:
    """Add a word if it isn't already tracked. No-op on duplicates."""
    word = word.strip().lower()
    if not word:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO words (word, source) VALUES (?, ?)",
            (word, source),
        )


def seed_from_file(path: Path) -> int:
    """Load one-word-per-line seed list. Returns how many lines were read."""
    if not path.exists():
        return 0
    words = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    for word in words:
        add_word(word, source="seed")
    return len(words)


def get_drilling_words(limit: int = 10) -> list[str]:
    """Words still in rotation, worst first: never-practiced, then high miss-rate."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT word FROM words
            WHERE status = 'drilling'
            ORDER BY (attempts = 0) DESC,
                     CAST(misses AS REAL) / MAX(attempts, 1) DESC,
                     COALESCE(last_seen, '') ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [row["word"] for row in rows]


def get_mastered_sample(n: int = 2) -> list[str]:
    """A few graduated words for surprise re-tests, so they don't creep back."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT word FROM words WHERE status = 'mastered' ORDER BY RANDOM() LIMIT ?",
            (n,),
        ).fetchall()
    return [row["word"] for row in rows]


def record_result(word: str, typed: str, correct: bool) -> None:
    """Log a raw attempt and roll the word's stats forward."""
    word = word.strip().lower()
    today = date.today().isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO attempts (word, typed, correct) VALUES (?, ?, ?)",
            (word, typed, int(correct)),
        )
        row = conn.execute("SELECT * FROM words WHERE word = ?", (word,)).fetchone()
        if row is None:
            # A generated word we weren't tracking yet — start tracking it.
            conn.execute("INSERT INTO words (word, source) VALUES (?, 'session')", (word,))
            row = conn.execute("SELECT * FROM words WHERE word = ?", (word,)).fetchone()

        attempts = row["attempts"] + 1
        misses = row["misses"] + (0 if correct else 1)
        streak = row["streak"] + 1 if correct else 0
        status = row["status"]
        if correct and streak >= MASTERY_STREAK:
            status = "mastered"
        elif not correct:
            status = "drilling"  # a miss pulls a word back into rotation

        conn.execute(
            """
            UPDATE words
            SET attempts = ?, misses = ?, streak = ?, status = ?, last_seen = ?
            WHERE word = ?
            """,
            (attempts, misses, streak, status, today, word),
        )


def render_markdown() -> None:
    """Rewrite weak_words.md from the DB — the human/agent-readable view."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT word, attempts, misses, streak, status, source, last_seen
            FROM words
            ORDER BY status, misses DESC, word
            """
        ).fetchall()

    lines = [
        "# Weak words",
        "",
        "| word | attempts | misses | streak | status | source | last seen |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['word']} | {row['attempts']} | {row['misses']} | "
            f"{row['streak']} | {row['status']} | {row['source']} | "
            f"{row['last_seen'] or '-'} |"
        )
    MD_PATH.write_text("\n".join(lines) + "\n")


def write_session_transcript(
    drills: list[dict],
    pattern_summary: str,
    new_words: list[dict],
) -> Path:
    """Write one markdown file per session into sessions/ as a running history.

    `drills` is a list of
    {"sentence", "typed", "words": [{"word", "typed", "correct"}]}. Each session
    gets its own timestamped file so the folder builds up a full history.
    """
    now = datetime.now()
    SESSIONS_DIR.mkdir(exist_ok=True)
    path = SESSIONS_DIR / f"{now:%Y-%m-%d_%H%M%S}.md"

    lines = [f"# Session {now:%Y-%m-%d %H:%M:%S}", ""]
    for i, drill in enumerate(drills, start=1):
        lines.append(f"## Drill {i}")
        lines.append(f"Prompt: {drill['sentence']}")
        lines.append(f"Typed:  {drill['typed']}")
        targets = []
        for word in drill["words"]:
            mark = "✓" if word["correct"] else f"✗ (typed \"{word['typed']}\")"
            targets.append(f"{word['word']} {mark}")
        lines.append("Targets: " + (", ".join(targets) if targets else "none"))
        lines.append("")

    lines.append("## Pattern")
    lines.append(pattern_summary)
    lines.append("")

    if new_words:
        lines.append("## Added to your list")
        for w in new_words:
            lines.append(f"- {w['word']}: {w['reason']}")
        lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
