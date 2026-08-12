#!/usr/bin/env bash
# Install both toolchains and pick the suffix this run will use.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_dotenv
require_env
require_uv
init_run_state

log "run suffix: ${PARITY_SUFFIX}"

log "syncing Python environment (uv)"
(cd "${PARITY_ROOT}/python" && uv sync --quiet)

log "building the JavaScript workspace dependency"
(cd "${REPO_ROOT}" && $(pnpm_bin) --filter @langchain/langgraph-checkpoint build >/dev/null)

log "setup complete"
