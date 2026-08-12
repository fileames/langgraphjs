"""Drop every table this parity run created.

Both languages create tables from the same suffix, so one sweep in Python is
enough. Safe to re-run: missing tables are ignored.
"""

from __future__ import annotations

import sys

import oracledb

from common import (
    connect_kwargs,
    index_config,
    report,
    run_suffix,
    store_suffix,
    whole_document_index_config,
)

TABLE_MISSING = 942


def store_table_names(suffix: str) -> list[str]:
    upper = suffix.upper()
    return [
        f"STORE_VECTORS_{upper}",
        f"VECTOR_MIGRATIONS_{upper}",
        f"STORE_{upper}",
        f"STORE_MIGRATIONS_{upper}",
    ]


def derived_suffixes() -> list[str]:
    """Suffixes the stores derive when no explicit one is given."""
    from langgraph_oracledb.store.oracle.base import _generate_suffix

    return [
        _generate_suffix(index_config()),
        _generate_suffix(whole_document_index_config()),
    ]


def drop(cursor, table: str) -> None:
    try:
        cursor.execute(f"DROP TABLE {table} CASCADE CONSTRAINTS PURGE")
        report("dropped", table)
    except oracledb.DatabaseError as exc:
        if getattr(exc.args[0], "code", None) != TABLE_MISSING:
            raise


def main() -> int:
    suffix = run_suffix()
    suffixes: list[str] = []
    for direction in ("py2js", "js2py"):
        for flavour in ("kv", "vec", "doc"):
            suffixes.append(store_suffix(direction, flavour))

    with oracledb.connect(**connect_kwargs()) as connection:
        with connection.cursor() as cursor:
            for table_suffix in suffixes:
                for table in store_table_names(table_suffix):
                    drop(cursor, table)

            # Stores created without an explicit suffix share derived tables
            # with anything else using the same index configuration, so only
            # the rows this run inserted are removed.
            for derived in derived_suffixes():
                try:
                    cursor.execute(
                        f"DELETE FROM STORE_{derived.upper()} "
                        "WHERE prefix LIKE 'parity.derived%'"
                    )
                    report("cleaned derived rows", derived)
                except oracledb.DatabaseError as exc:
                    if getattr(exc.args[0], "code", None) != TABLE_MISSING:
                        raise

            # Checkpoints live in the shared bare tables; remove only the
            # threads this run created.
            for direction in ("py2js", "js2py"):
                for table in (
                    "CHECKPOINT_WRITES",
                    "CHECKPOINT_BLOBS",
                    "CHECKPOINTS",
                ):
                    try:
                        cursor.execute(
                            f"DELETE FROM {table} WHERE thread_id LIKE :pattern",
                            {"pattern": f"{direction}:parity-%"},
                        )
                    except oracledb.DatabaseError as exc:
                        if getattr(exc.args[0], "code", None) != TABLE_MISSING:
                            raise
                report("cleaned checkpoint threads", direction)

            try:
                cursor.execute(
                    "DELETE FROM STORE_CONFIGS WHERE table_suffix LIKE :pattern",
                    {"pattern": f"{suffix}%"},
                )
            except oracledb.DatabaseError as exc:
                if getattr(exc.args[0], "code", None) != TABLE_MISSING:
                    raise

            connection.commit()

    report("teardown complete", suffix)
    return 0


if __name__ == "__main__":
    sys.exit(main())
