#!/usr/bin/env bash
# Shared setup for every parity step. Source this, do not execute it.

set -euo pipefail

PARITY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_ROOT="$(cd "${PARITY_ROOT}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_ROOT}/../.." && pwd)"
STATE_FILE="${PARITY_ROOT}/.state/run.env"

export PARITY_ROOT PACKAGE_ROOT REPO_ROOT

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require_env() {
  local missing=0
  for name in ORACLE_USER ORACLE_PASSWORD ORACLE_CONNECT_STRING; do
    if [[ -z "${!name:-}" ]]; then
      warn "${name} is not set"
      missing=1
    fi
  done
  if [[ "${missing}" -eq 1 ]]; then
    die "Set ORACLE_USER, ORACLE_PASSWORD and ORACLE_CONNECT_STRING first (a .env in the package root is also read)."
  fi
}

# Load the package .env if the caller has not exported credentials already.
load_dotenv() {
  if [[ -z "${ORACLE_USER:-}" && -f "${PACKAGE_ROOT}/.env" ]]; then
    log "loading ${PACKAGE_ROOT}/.env"
    set -a
    # shellcheck disable=SC1091
    source "${PACKAGE_ROOT}/.env"
    set +a
  fi
}

# One suffix per run, shared by both languages and every phase.
init_run_state() {
  mkdir -p "${PARITY_ROOT}/.state"
  # A new suffix on every setup. Re-running a writer against an already
  # registered configuration hits a Python bug (see parity/README.md), and a
  # fresh suffix keeps each run independent anyway.
  if [[ -n "${PARITY_SUFFIX:-}" ]]; then
    printf 'PARITY_SUFFIX=%s\n' "${PARITY_SUFFIX}" > "${STATE_FILE}"
  else
    local generated
    generated="P$(date +%s | tail -c 7)$(printf '%04d' $((RANDOM % 10000)))"
    printf 'PARITY_SUFFIX=%s\n' "${generated}" > "${STATE_FILE}"
  fi
  # shellcheck disable=SC1090
  source "${STATE_FILE}"
  export PARITY_SUFFIX
}

load_run_state() {
  [[ -f "${STATE_FILE}" ]] || die "No run state. Run parity/sh/00-setup.sh first."
  # shellcheck disable=SC1090
  source "${STATE_FILE}"
  export PARITY_SUFFIX
}

clear_run_state() {
  rm -f "${STATE_FILE}"
}

pnpm_bin() {
  if command -v pnpm >/dev/null 2>&1; then
    echo pnpm
  elif command -v corepack >/dev/null 2>&1; then
    echo "corepack pnpm"
  else
    die "pnpm not found. Install pnpm or enable corepack."
  fi
}

# Resolve a locally installed binary by absolute path.
#
# `pnpm exec` refuses to run from parity/js because that directory has no
# package.json of its own, so the binaries are located directly instead.
node_bin() {
  local name="$1"
  for dir in "${PACKAGE_ROOT}/node_modules/.bin" "${REPO_ROOT}/node_modules/.bin"; do
    if [[ -x "${dir}/${name}" ]]; then
      echo "${dir}/${name}"
      return 0
    fi
  done
  die "${name} not found. Run pnpm install at the repository root first."
}

require_uv() {
  command -v uv >/dev/null 2>&1 || die "uv not found. See https://docs.astral.sh/uv/"
}
