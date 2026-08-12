#!/usr/bin/env bash
# Phase 1b: JavaScript reads what Python wrote.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
load_run_state

log "javascript reads (direction py2js, suffix ${PARITY_SUFFIX})"
cd "${PARITY_ROOT}/js"
PARITY_DIRECTION=py2js $(pnpm_bin) exec vitest run --config vitest.config.ts
