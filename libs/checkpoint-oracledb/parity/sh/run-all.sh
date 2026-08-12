#!/usr/bin/env bash
# Full ordered run: setup, both directions, teardown.
#
#   ./run-all.sh            # run everything and clean up
#   KEEP=1 ./run-all.sh     # leave the tables in place for inspection
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${HERE}/00-setup.sh"

# Order matters: each reader needs the other language's writer to have run.
"${HERE}/01-python-writes.sh"
"${HERE}/02-js-reads.sh"
"${HERE}/03-js-writes.sh"
"${HERE}/04-python-reads.sh"

if [[ -n "${KEEP:-}" ]]; then
  load_run_state
  log "KEEP set: leaving tables for suffix ${PARITY_SUFFIX}"
  log "drop them later with parity/sh/99-teardown.sh"
else
  "${HERE}/99-teardown.sh"
fi

log "parity run finished"
