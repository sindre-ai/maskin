# whisper.cpp Server Setup

The Maskin notetaker extension uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp) as a local speech-to-text server. This document explains how to set it up for local development.

## Quick Start (Docker)

The easiest way is to use Docker Compose, which builds whisper.cpp and downloads the model automatically:

```bash
docker-compose up whisper-server
```

The server will be available at `http://localhost:8178`.

## Quick Start (Native)

If you prefer running whisper-server natively (faster inference, especially with GPU):

### Prerequisites

- **C/C++ compiler** (gcc, clang, or MSVC)
- **CMake** ≥ 3.14
- **Git**
- ~1 GB disk space for the `small` model (~3 GB for `medium`)

### Steps

```bash
# 1. Build whisper.cpp and download the model
./scripts/setup-whisper.sh

# 2. Start the server
./scripts/start-whisper-server.sh
```

The server will start on `http://127.0.0.1:8178`.

### Configuration

All settings are configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `WHISPER_DIR` | `vendor/whisper.cpp` | Path to the whisper.cpp directory |
| `WHISPER_MODEL` | `small` | Model size: `tiny`, `base`, `small`, `medium`, `large` |
| `WHISPER_HOST` | `127.0.0.1` | Server bind address |
| `WHISPER_PORT` | `8178` | Server port |
| `WHISPER_THREADS` | `4` | Number of CPU threads for inference |
| `WHISPER_TAG` | `v1.7.3` | whisper.cpp git tag to build |

Example with custom settings:

```bash
WHISPER_MODEL=medium WHISPER_PORT=9090 WHISPER_THREADS=8 ./scripts/start-whisper-server.sh
```

### Model Sizes

| Model | Disk | RAM | Speed | Quality |
|---|---|---|---|---|
| `tiny` | ~75 MB | ~390 MB | Fastest | Basic |
| `base` | ~142 MB | ~500 MB | Fast | Good |
| `small` | ~466 MB | ~1.0 GB | Moderate | Great (recommended) |
| `medium` | ~1.5 GB | ~2.6 GB | Slow | Excellent |
| `large` | ~3.1 GB | ~4.7 GB | Slowest | Best |

We default to `small` as it provides a good balance of speed and accuracy for development.

## API Usage

The whisper-server exposes an HTTP API compatible with the OpenAI Whisper API format.

### Transcribe audio

```bash
curl -X POST http://localhost:8178/inference \
  -F "file=@audio.wav" \
  -F "response_format=json"
```

### Health check

```bash
curl http://localhost:8178/health
```

## Running Alongside the Monolith

### With Docker Compose

```bash
# Start everything including whisper-server
docker-compose up -d postgres seaweedfs whisper-server

# Then start the dev servers as usual
pnpm dev
```

### Natively

Use the dev script with whisper support:

```bash
# Terminal 1: Start whisper-server
./scripts/start-whisper-server.sh

# Terminal 2: Start the monolith as usual
pnpm dev
```

Or use the combined startup:

```bash
WHISPER_ENABLED=true pnpm dev
```

## Troubleshooting

**Build fails with CMake errors**: Ensure CMake ≥ 3.14 is installed. On macOS: `brew install cmake`. On Ubuntu: `sudo apt install cmake`.

**Model download fails**: The download script fetches from Hugging Face. If behind a proxy, set `HTTPS_PROXY`.

**Server crashes on start**: Check that the model file exists at `vendor/whisper.cpp/models/ggml-<model>.bin`. Re-run `./scripts/setup-whisper.sh` if needed.

**Slow inference**: Try the `tiny` or `base` model for faster results during development. Or increase `WHISPER_THREADS`.
