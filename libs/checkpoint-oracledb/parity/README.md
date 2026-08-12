# Python ↔ JavaScript parity suite

Standalone cross-language checks: one language writes to Oracle, the other
reads it back, in **both** directions. Nothing here runs as part of `pnpm test`
or `pnpm test:int` — the package's vitest config excludes `parity/**`, because
these tests are only meaningful once the other language's writer has finished.

This is the check that the rest of the suite cannot make. Every other test
verifies one language against its own expectations; only this one can catch a
serialisation, naming, or ranking difference that silently splits the two.

## Requirements

- A reachable Oracle Database (23ai or later for the vector cases)
- [`uv`](https://docs.astral.sh/uv/) for the Python environment
- `pnpm` (or `corepack`)
- `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_CONNECT_STRING` exported, or a
  `.env` in the package root — `sh/lib.sh` reads it if the variables are unset

## Running

```bash
cd libs/checkpoint-oracledb/parity/sh
./run-all.sh                # setup, both directions, teardown
KEEP=1 ./run-all.sh         # leave the tables behind for inspection
```

Order is not optional, so each phase is its own script:

| Script | Phase |
| --- | --- |
| `00-setup.sh` | `uv sync`, build the JS workspace dep, choose the run suffix |
| `01-python-writes.sh` | Python writes every fixture (`py2js`) |
| `02-js-reads.sh` | JavaScript reads and asserts (`py2js`) |
| `03-js-writes.sh` | JavaScript writes every fixture (`js2py`) |
| `04-python-reads.sh` | Python reads and asserts (`js2py`) |
| `99-teardown.sh` | Drops the tables and rows this run created |

Each script can be run on its own once `00-setup.sh` has picked the suffix,
which is stored in `.state/run.env` so every phase agrees on it. Every
`00-setup.sh` picks a **new** suffix, so runs never reuse each other's tables;
pin one with `PARITY_SUFFIX=... ./00-setup.sh` if you need to.

Re-running a writer phase against a suffix it already wrote will fail on the
Python side — see *Upstream bugs found* below. Run `99-teardown.sh` and start a
fresh run instead.

## How the two sides stay honest

`fixtures/cases.json` is the single source of truth. Both languages read the
same file, so neither can quietly change what it thinks was written. The
Python and JavaScript halves each implement the same deterministic embedding
(bucket code points, L2-normalise) in `python/common.py` and `js/src/common.ts`
— no model, no network, and identical vectors, which is what makes a
cross-language ranking comparison mean anything.

Runs are scoped two ways so they never collide: table suffixes carry the run
suffix, and checkpoint thread ids are prefixed with the direction. The Python
saver has no `table_suffix` option yet, so the checkpoint half of both
directions shares the bare `CHECKPOINTS` tables and separates by thread id.

## What is covered

**Checkpoints** — JSON channel values of every type, unicode, empty
string/object/array, empty and non-empty `checkpoint_ns` (including the
single-space sentinel not leaking into the public config), parent lineage,
pending writes across several tasks including `__error__`, binary channel
values, empty byte arrays, a 200 KB value, the BLOB path (both sides run with
`json_size_threshold_mb=0`), metadata with nested objects and unicode, the
`Decimal` → `int` coercion Python needs, and `list()`.

**Store** — every JSON type, unicode namespaces and keys, deeply nested
namespaces, `get`, `search` by namespace prefix, scalar and operator filters,
`listNamespaces`, and TTL rows.

**Vector search** — ranking agreement in both directions, exclusion of items
written with `index=False`, and a whole-document case that indexes with the
default `fields` so that `get_text_at_path` serialisation itself is compared:
if the two languages serialise a document differently, the identical query
stops scoring at the cosine maximum and the test fails.

**Derived table suffixes** — a store created with no explicit suffix in each
language must land on the same tables, which is the A5 hash agreement.

## Known divergences

`fixtures/cases.json` records the behaviours that deliberately differ
(checkpoint metadata filters, expired-row visibility, namespace prefix
matching). They are documented rather than asserted, so this suite stays a
parity check rather than a snapshot of current bugs. If you want them to fail
loudly, promote them to assertions.

## Upstream bugs found

**`langgraph-oracledb` (Python): Decimal index params break `setup()`**

`OracleStore.setup()` raises `TypeError: Object of type Decimal is not JSON
serializable` whenever it re-validates a registered index configuration that
contains a numeric `index_type` parameter. `_validate_configuration`
`json.dumps()` the `index_params` it reads back from the Oracle JSON column,
where numbers arrive as `Decimal`. The checkpoint side already has
`_coerce_decimals` for exactly this; the store never applies it.

No JavaScript involved — two consecutive Python `setup()` calls reproduce it:

```bash
cd parity/python && uv run python known_bugs/decimal_index_params.py
```

The JavaScript store is unaffected, because `assertStoredIndexConfigMatches`
parses the JSON column into plain numbers.

Until it is fixed upstream, the shared index configuration in this suite uses
no numeric `index_type` parameters. That is a workaround, not a preference —
restore `neighbor_partitions` once the fix ships.

## Troubleshooting

The JavaScript steps invoke `vitest` and `tsx` by absolute path from
`libs/checkpoint-oracledb/node_modules/.bin`. `pnpm exec` is not used there:
`parity/js` has no `package.json`, and pnpm refuses to run from a directory
outside a workspace package. For the same reason `js/vitest.config.ts` pins
`root` to its own directory rather than relying on the working directory.

## Caveat

This suite has not been executed against a live database — it was written
without one available. Expect to iterate on the first run, particularly around
the Python fixture APIs, where argument names differ slightly between
`langgraph-oracledb` releases.
