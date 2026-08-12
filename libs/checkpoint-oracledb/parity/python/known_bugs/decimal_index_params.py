"""Standalone reproduction: Decimal index params break OracleStore.setup().

`langgraph-oracledb` cannot re-validate a registered index configuration that
contains any numeric `index_type` parameter. No JavaScript involved: two
consecutive `setup()` calls from Python are enough.

    _validate_configuration()
      -> _normalize_existing_index_params(existing_params)   # Oracle JSON
         -> dict with Decimal values
      -> json.dumps(existing_params_dict, sort_keys=True)
         -> TypeError: Object of type Decimal is not JSON serializable

The checkpoint side already has `_coerce_decimals` for exactly this reason
(`checkpoint/oracle/base.py`); the store never applies it.

Affected parameters: every numeric one under `index_type` — `neighbors`,
`efconstruction`, `neighbor_partitions`, `samples_per_partition`,
`min_vectors_per_partition`. A config with no numeric `index_type` parameter is
unaffected, which is why default configurations never hit it. `accuracy` alone
is also unaffected because it is popped before the dump.

Run:

    cd parity/python && uv run python known_bugs/decimal_index_params.py

Exit code 0 means the bug reproduced (setup failed the second time), 1 means it
appears to be fixed in the installed version.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import oracledb  # noqa: E402
from langgraph_oracledb.store.oracle import OracleStore  # noqa: E402

from common import ParityEmbeddings, conn_string, connect_kwargs  # noqa: E402

SUFFIX = "decimalbugrepro"


def index_config() -> dict:
    return {
        "dims": 8,
        "embed": ParityEmbeddings(),
        "fields": ["text"],
        # Any numeric value here is enough.
        "index_type": {"type": "ivf", "neighbor_partitions": 1},
    }


def drop_everything() -> None:
    upper = SUFFIX.upper()
    with oracledb.connect(**connect_kwargs()) as connection:
        with connection.cursor() as cursor:
            for table in (
                f"STORE_VECTORS_{upper}",
                f"VECTOR_MIGRATIONS_{upper}",
                f"STORE_{upper}",
                f"STORE_MIGRATIONS_{upper}",
            ):
                try:
                    cursor.execute(f"DROP TABLE {table} CASCADE CONSTRAINTS PURGE")
                except oracledb.DatabaseError as exc:
                    if getattr(exc.args[0], "code", None) != 942:
                        raise
            try:
                cursor.execute(
                    "DELETE FROM STORE_CONFIGS WHERE table_suffix = :s", {"s": SUFFIX}
                )
            except oracledb.DatabaseError as exc:
                if getattr(exc.args[0], "code", None) != 942:
                    raise
            connection.commit()


def main() -> int:
    drop_everything()
    try:
        print("first setup(): registers the configuration")
        with OracleStore.from_conn_string(
            conn_string(), index=index_config(), table_suffix=SUFFIX
        ) as store:
            store.setup()
        print("  ok")

        print("second setup(): re-validates the registered configuration")
        try:
            with OracleStore.from_conn_string(
                conn_string(), index=index_config(), table_suffix=SUFFIX
            ) as store:
                store.setup()
        except TypeError as exc:
            if "Decimal" in str(exc):
                print(f"  reproduced: {exc}")
                return 0
            raise
        print("  no error: the installed version appears to be fixed")
        return 1
    finally:
        drop_everything()


if __name__ == "__main__":
    sys.exit(main())
