#!/usr/bin/env bash
set -euo pipefail

# Starts the whisper.cpp HTTP server with sensible defaults.
# All settings can be overridden via environment variables.

WHISPER_DIR="${WHISPER_DIR:-vendor/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-small}"
WHISPER_HOST="${WHISPER_HOST:-127.0.0.1}"
WHISPER_PORT="${WHISPER_PORT:-8178}"
WHISPER_THREADS="${WHISPER_THREADS:-4}"

SERVER_BIN="${WHISPER_DIR}/build/bin/whisper-server"
MODEL_FILE="${WHISPER_DIR}/models/ggml-${WHISPER_MODEL}.bin"

if [ ! -f "${SERVER_BIN}" ]; then
  echo "Error: whisper-server binary not found at ${SERVER_BIN}"
  echo "Run ./scripts/setup-whisper.sh first."
  exit 1
fi

if [ ! -f "${MODEL_FILE}" ]; then
  echo "Error: Model file not found at ${MODEL_FILE}"
  echo "Run ./scripts/setup-whisper.sh first."
  exit 1
fi

echo "Starting whisper-server on ${WHISPER_HOST}:${WHISPER_PORT}"
echo "  Model:   ${MODEL_FILE}"
echo "  Threads: ${WHISPER_THREADS}"

exec "${SERVER_BIN}" \
  --model "${MODEL_FILE}" \
  --host "${WHISPER_HOST}" \
  --port "${WHISPER_PORT}" \
  --threads "${WHISPER_THREADS}" \
  --language auto \
  --print-progress
