"""SQLite storage for the typing trainer.

This is the source of truth for word stats. `weak_words.md` is a human-readable
view rendered from here, and the agent never does the arithmetic — the plain
functions below own attempts / misses / streak / graduation.

Everything here reads and writes whichever profile is active for the current
request, so the practice loop never has to know there's more than one.
"""

from __future__ import annotations

import sqlite3
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Clean hits in a row before a word graduates from "drilling" to "mastered".
MASTERY_STREAK = 10


@dataclass(frozen=True)
class Profile:
    """One self-contained world: its own database, word list, and transcripts.

    Separate *files* rather than a flag column on every row. A flag is only as
    good as the WHERE clause you remember to write, and the one thing this
    feature has to guarantee is that a throwaway session can never touch the
    real numbers.
    """

    db: Path
    markdown: Path
    sessions: Path


PROFILES: dict[str, Profile] = {
    "personal": Profile(
        db=BASE_DIR / "typing.db",
        markdown=BASE_DIR / "weak_words.md",
        sessions=BASE_DIR / "sessions",
    ),
    "testing": Profile(
        db=BASE_DIR / "typing_test.db",
        markdown=BASE_DIR / "weak_words_test.md",
        sessions=BASE_DIR / "sessions_test",
    ),
}

DEFAULT_PROFILE = "personal"

_active: ContextVar[str] = ContextVar("profile", default=DEFAULT_PROFILE)


def use_profile(name: str) -> None:
    """Point every subsequent read and write at one profile."""
    if name not in PROFILES:
        raise ValueError(f"unknown profile: {name!r}")
    _active.set(name)


def active_profile() -> Profile:
    return PROFILES[_active.get()]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(active_profile().db)
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

            CREATE TABLE IF NOT EXISTS sessions (
                id         INTEGER PRIMARY KEY,
                started_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id         INTEGER PRIMARY KEY,
                word       TEXT NOT NULL,
                typed      TEXT NOT NULL,
                correct    INTEGER NOT NULL,
                session_id INTEGER REFERENCES sessions(id),
                timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS drills (
                id          INTEGER PRIMARY KEY,
                sentence    TEXT NOT NULL,
                typed       TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                session_id  INTEGER REFERENCES sessions(id),
                timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )
        # Tables created before sessions existed keep their old shape, because
        # CREATE TABLE IF NOT EXISTS won't alter them. Rows from back then stay
        # NULL: those drills predate any notion of a session, and guessing at
        # their boundaries from timestamps would invent history we don't have.
        _add_column(conn, "attempts", "session_id INTEGER REFERENCES sessions(id)")
        _add_column(conn, "drills", "session_id INTEGER REFERENCES sessions(id)")


def _add_column(conn: sqlite3.Connection, table: str, declaration: str) -> None:
    """Add a column to an existing table, no-op if it's already there."""
    name = declaration.split()[0]
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if name not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {declaration}")


def start_session() -> int:
    """Open a session and return its id, to stamp on this sitting's rows."""
    with _connect() as conn:
        cursor = conn.execute("INSERT INTO sessions DEFAULT VALUES")
        return int(cursor.lastrowid)


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


def get_all_words() -> list[dict]:
    """Every tracked word with its counters, worst first. Backs both the stats
    endpoint and the markdown view, so the ordering only lives here."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT word, attempts, misses, streak, status, source, last_seen
            FROM words
            ORDER BY status, misses DESC, word
            """
        ).fetchall()
    return [dict(row) for row in rows]


def record_drill(
    sentence: str,
    typed: str,
    duration_ms: int,
    session_id: int | None = None,
) -> None:
    """Log one timed sentence. The raw material for words-per-minute, which
    can't be backfilled if we don't capture it as it happens."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO drills (sentence, typed, duration_ms, session_id)
            VALUES (?, ?, ?, ?)
            """,
            (sentence, typed, duration_ms, session_id),
        )


def get_typing_stats(session_id: int | None = None) -> dict[str, int]:
    """Words-per-minute across timed drills, or just one session's worth.

    The average is total characters over total time, not the mean of the
    per-sentence rates. Averaging the rates would let a four-word sentence
    count as heavily as a full one, which flatters a fast start.

    A "word" is five characters, the standard typing-test convention, so this
    stays comparable to any other wpm number you've seen.

    The session filter is a WHERE clause rather than a second function, so the
    number on the results screen can't drift from the one on the stats tab.
    """
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*)           AS drills,
                   SUM(LENGTH(typed)) AS chars,
                   SUM(duration_ms)   AS total_ms,
                   MAX(LENGTH(typed) * 60000.0 / (5 * duration_ms)) AS best_wpm
            FROM drills
            WHERE duration_ms > 0
              AND LENGTH(typed) > 0
              AND (? IS NULL OR session_id = ?)
            """,
            (session_id, session_id),
        ).fetchone()

    # A skipped sentence has no time and no text, so it's filtered out above.
    # With every row filtered the SUMs come back NULL, hence the early return.
    if not row["drills"]:
        return {"drills": 0, "avg_wpm": 0, "best_wpm": 0}

    return {
        "drills": row["drills"],
        "avg_wpm": round(row["chars"] * 60000 / (5 * row["total_ms"])),
        "best_wpm": round(row["best_wpm"]),
    }


def record_result(
    word: str,
    typed: str,
    correct: bool,
    session_id: int | None = None,
) -> None:
    """Log a raw attempt and roll the word's stats forward."""
    word = word.strip().lower()
    today = date.today().isoformat()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO attempts (word, typed, correct, session_id)
            VALUES (?, ?, ?, ?)
            """,
            (word, typed, int(correct), session_id),
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
    """Rewrite the active profile's word list from the DB — the human-readable view."""
    rows = get_all_words()

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
    active_profile().markdown.write_text("\n".join(lines) + "\n")


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
    sessions_dir = active_profile().sessions
    sessions_dir.mkdir(exist_ok=True)
    path = sessions_dir / f"{now:%Y-%m-%d_%H%M%S}.md"

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
