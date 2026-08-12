#!/usr/bin/env bash
# Phase 2a: JavaScript writes every fixture.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
load_run_state

log "javascript writes (direction js2py, suffix ${PARITY_SUFFIX})"
cd "${PARITY_ROOT}/js"
PARITY_DIRECTION=js2py "$(node_bin tsx)" "${PARITY_ROOT}/js/src/write.ts"
