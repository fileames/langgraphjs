#!/usr/bin/env bash
# Phase 1a: Python writes every fixture.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
require_uv
load_run_state

log "python writes (direction py2js, suffix ${PARITY_SUFFIX})"
cd "${PARITY_ROOT}/python"
PARITY_DIRECTION=py2js uv run python write.py
