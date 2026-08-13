# `OracleStore.setup()` fails with `TypeError: Object of type Decimal is not JSON serializable` when an index config has a numeric `index_type` parameter

**Package:** `langgraph-oracledb` 1.0.1
**Affects:** `OracleStore` and `AsyncOracleStore`

## Summary

Calling `setup()` a second time on a store that was created with an explicit
`table_suffix` and an `index_type` containing any numeric parameter raises a
`TypeError`. The store becomes unusable from that point on: every subsequent
`setup()` fails the same way, so the tables can be created once and then never
reopened.

## Reproduction

```python
from langgraph_oracledb.store.oracle import OracleStore

CONN = "user/password@localhost:1521/FREEPDB1"

index = {
    "dims": 8,
    "embed": my_embeddings,                      # any Embeddings instance
    "fields": ["text"],
    "index_type": {"type": "ivf", "neighbor_partitions": 1},   # any number here
}

# First run: registers the configuration in STORE_CONFIGS.
with OracleStore.from_conn_string(CONN, index=index, table_suffix="demo") as store:
    store.setup()          # ok

# Second run: re-validates the registered configuration.
with OracleStore.from_conn_string(CONN, index=index, table_suffix="demo") as store:
    store.setup()          # TypeError
```

## Actual result

```
  File ".../langgraph_oracledb/store/oracle/base.py", line 1325, in setup
    self._validate_configuration(self.table_suffix, self.index_config)
  File ".../langgraph_oracledb/store/oracle/base.py", line 1177, in _validate_configuration
    existing_params_normalized = json.dumps(
        existing_params_dict, sort_keys=True
    )
  ...
TypeError: Object of type Decimal is not JSON serializable
```

## Expected result

`setup()` succeeds and the configuration compares equal to the registered one.

## Cause

`STORE_CONFIGS.index_params` is an Oracle `JSON` column. `python-oracledb`
returns its numbers as `decimal.Decimal`. `_normalize_existing_index_params`
(`store/oracle/base.py:352`) returns the mapping unchanged, and
`_validate_configuration` then hands it straight to `json.dumps`:

```python
# store/oracle/base.py:1182
existing_params_dict = _normalize_existing_index_params(existing_params)
...
# store/oracle/base.py:1193
existing_params_normalized = json.dumps(existing_params_dict, sort_keys=True)
```

`json.dumps` has no encoder for `Decimal`, so it raises.

`AsyncOracleStore` has the same defect through the same helper
(`store/oracle/aio.py:236` and `:247`).

The checkpoint side already solves exactly this problem —
`BaseOracleSaver._coerce_decimals` (`checkpoint/oracle/base.py:603`) exists
because "Oracle's native JSON type deserializes every number as `Decimal`" —
but the store never applies it.

## Trigger conditions

All three are required:

1. an explicit `table_suffix` (a derived suffix sets `_needs_validation = False`,
   so `_validate_configuration` is skipped)
2. an `index_type` containing at least one numeric value — `neighbors`,
   `efconstruction`, `neighbor_partitions`, `samples_per_partition`, or
   `min_vectors_per_partition`
3. a configuration already registered in `STORE_CONFIGS`, i.e. any run after
   the first

An `index_type` with no numeric parameter is unaffected, which is why default
configurations do not hit this. `accuracy` alone is also unaffected, because it
is `pop`ped from the dict before the dump.

## Suggested fix

Coerce in `_normalize_existing_index_params`, so both the sync and async stores
are covered by one change:

```python
def _normalize_existing_index_params(existing_params: Any) -> dict[str, Any]:
    ...
    if isinstance(existing_params, Mapping):
        return _coerce_decimals(dict(existing_params))
```

reusing the existing helper from `checkpoint/oracle/base.py`, or equivalently
passing `default=` to the two `json.dumps` calls. Comparing the parsed
structures rather than their serialised forms would avoid the class of problem
altogether.

## Notes

- A standalone reproduction script is attached below; it drops and recreates
  its own tables and exits `0` when the bug reproduces, `1` if it is fixed.
- The JavaScript port
  (`@langchain/langgraph-checkpoint-oracledb`) is not affected: it parses the
  same JSON column into plain numbers before comparing.
- Found while building a cross-language parity suite between the two packages.
