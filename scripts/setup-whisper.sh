#!/usr/bin/env bash
set -euo pipefail

# Setup script for whisper.cpp server
# Downloads, compiles whisper.cpp and downloads a Whisper model for local development.

WHISPER_DIR="${WHISPER_DIR:-vendor/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-small}"
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp.git"
WHISPER_TAG="${WHISPER_TAG:-v1.7.3}"
MODELS_DIR="${WHISPER_DIR}/models"

echo "==> Setting up whisper.cpp (model: ${WHISPER_MODEL})"

# ── 1. Clone whisper.cpp if not present ──────────────────────────────────────
if [ ! -d "${WHISPER_DIR}" ]; then
  echo "Cloning whisper.cpp ${WHISPER_TAG}..."
  git clone --depth 1 --branch "${WHISPER_TAG}" "${WHISPER_REPO}" "${WHISPER_DIR}"
else
  echo "whisper.cpp already exists at ${WHISPER_DIR}, skipping clone."
fi

# ── 2. Build whisper.cpp and the server ──────────────────────────────────────
echo "Building whisper.cpp..."
cd "${WHISPER_DIR}"

cmake -B build -DWHISPER_BUILD_SERVER=ON
cmake --build build --config Release -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo "Build complete. Server binary: build/bin/whisper-server"

# ── 3. Download model ────────────────────────────────────────────────────────
MODEL_FILE="${MODELS_DIR}/ggml-${WHISPER_MODEL}.bin"
if [ -f "${MODEL_FILE}" ]; then
  echo "Model already downloaded: ${MODEL_FILE}"
else
  echo "Downloading ggml-${WHISPER_MODEL} model..."
  bash ./models/download-ggml-model.sh "${WHISPER_MODEL}"
fi

echo ""
echo "==> whisper.cpp setup complete!"
echo "    Server binary: ${WHISPER_DIR}/build/bin/whisper-server"
echo "    Model file:    ${MODEL_FILE}"
echo ""
echo "    Run with: ./scripts/start-whisper-server.sh"
