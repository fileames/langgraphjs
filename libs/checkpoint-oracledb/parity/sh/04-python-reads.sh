#!/usr/bin/env bash
# Phase 2b: Python reads what JavaScript wrote.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
require_uv
load_run_state

log "python reads (direction js2py, suffix ${PARITY_SUFFIX})"
cd "${PARITY_ROOT}/python"
PARITY_DIRECTION=js2py uv run pytest test_read.py
