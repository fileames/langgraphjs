#!/usr/bin/env bash
# Drop everything this run created. Safe to re-run.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
require_uv
load_run_state

log "dropping artefacts for suffix ${PARITY_SUFFIX}"
cd "${PARITY_ROOT}/python"
uv run python teardown.py

clear_run_state
log "teardown complete"
