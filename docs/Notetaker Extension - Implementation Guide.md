# Notetaker Extension — Implementation Guide

**Maskin Platform | March 2026 | Internal — Dev Team**

---

## 1. Prerequisites

Before starting implementation, ensure the following are available:

- A Linux server (Ubuntu 22+ recommended) with at least 4 CPU cores and 4–8 GB RAM
- Node.js 18+ and TypeScript (already in the Maskin stack)
- Docker and docker-compose (for containerized deployment)
- A C/C++ compiler (gcc/g++ or clang) for building whisper.cpp
- A Recall.ai API account and API key
- Google Cloud Console and/or Azure AD app registrations for calendar OAuth

## 2. Setting Up whisper.cpp

### 2.1 Build from Source

Clone the repository and build the server binary:

```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

This produces the whisper-server binary at `build/bin/whisper-server`.

### 2.2 Download a Model

Download the Whisper model you want to use. We recommend starting with the small model for initial development and moving to medium for production:

```bash
# Download small model (~500MB RAM, good balance)
bash ./models/download-ggml-model.sh small

# Or download medium model (~1.5GB RAM, better accuracy)
bash ./models/download-ggml-model.sh medium
```

### 2.3 Run the Server

Start whisper-server with your chosen model:

```bash
./build/bin/whisper-server \
  --model models/ggml-small.bin \
  --host 127.0.0.1 \
  --port 8080 \
  --threads 4
```

Key configuration flags:

| Flag | Description |
|------|-------------|
| `--model` | Path to the GGML model file |
| `--host` | Bind address. Use 127.0.0.1 to restrict to localhost only. |
| `--port` | HTTP port (default: 8080) |
| `--threads` | Number of CPU threads. Set to number of available cores. |
| `--language` | Force a language (e.g., en). Omit for auto-detection. |

### 2.4 Verify It Works

Test the server with a sample audio file using curl:

```bash
curl http://127.0.0.1:8080/inference \
  -H "Content-Type: multipart/form-data" \
  -F file=@samples/jfk.wav \
  -F response_format=json
```

## 3. Docker Setup

### 3.1 Dockerfile for whisper-server

Create a Dockerfile that builds whisper.cpp and bundles the model:

```dockerfile
FROM ubuntu:22.04 AS builder
RUN apt-get update && apt-get install -y \
    build-essential cmake git
RUN git clone https://github.com/ggerganov/whisper.cpp.git /whisper
WORKDIR /whisper
RUN cmake -B build && cmake --build build --config Release

FROM ubuntu:22.04
COPY --from=builder /whisper/build/bin/whisper-server /usr/local/bin/
COPY models/ggml-small.bin /models/ggml-small.bin
EXPOSE 8080
CMD ["whisper-server", "--model", "/models/ggml-small.bin", \
     "--host", "0.0.0.0", "--port", "8080", "--threads", "4"]
```

### 3.2 docker-compose.yml

Run the monolith and whisper-server together:

```yaml
version: "3.8"
services:
  maskin:
    build: .
    ports:
      - "3000:3000"
    environment:
      - WHISPER_URL=http://whisper:8080
    depends_on:
      - whisper

  whisper:
    build:
      context: .
      dockerfile: Dockerfile.whisper
    ports:
      - "8080:8080"
```

In docker-compose, the monolith reaches whisper-server at `http://whisper:8080` (Docker's internal DNS). In local dev without Docker, use `http://127.0.0.1:8080`. The `WHISPER_URL` environment variable handles this difference.

## 4. TypeScript Transcription Service

### 4.1 Service Module

Create the transcription service as a module within the extension. This is the internal API that all other parts of the extension call to transcribe audio:

```typescript
// extensions/notetaker/services/transcription.ts

interface TranscriptionResult {
  text: string;
  language: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

const WHISPER_URL = process.env.WHISPER_URL || "http://127.0.0.1:8080";

export async function transcribe(
  audioBuffer: Buffer,
  filename: string
): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("response_format", "json");

  const res = await fetch(`${WHISPER_URL}/inference`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status}`);
  }

  return res.json();
}
```

### 4.2 Health Check

Add a health check so the extension can verify whisper-server is running:

```typescript
export async function checkWhisperHealth(): Promise<boolean> {
  try {
    const res = await fetch(WHISPER_URL, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

### 4.3 Error Handling and Retries

The transcription service should handle the following error scenarios:

- **whisper-server is down:** Return a clear error to the caller. The extension onboarding UI should show a warning if the health check fails.
- **Timeout on long audio:** Set a generous timeout (e.g., 10 minutes for a 1-hour recording). Consider processing long recordings asynchronously with a job queue.
- **Invalid audio format:** Validate the file format before sending to whisper-server. Supported: WAV, MP3, M4A, WebM.
- **Retries:** Retry up to 2 times with exponential backoff for transient failures (connection reset, 5xx errors). Do not retry on 4xx errors.

## 5. Audio File Upload Endpoint

### 5.1 API Specification

| Property | Value |
|----------|-------|
| Endpoint | `POST /api/extensions/notetaker/upload` |
| Content-Type | `multipart/form-data` |
| Auth | Standard Maskin session/API key auth |
| Max file size | 500 MB (configurable) |
| Accepted formats | `.wav, .mp3, .m4a, .webm` |

### 5.2 Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The audio file to transcribe |
| `title` | String | No | Title for the resulting note object. Defaults to filename. |
| `language` | String | No | Force language (e.g., "en"). Omit for auto-detection. |
| `linkedObjectId` | String | No | ID of a bet/task to link the transcription to. |

### 5.3 Response

On success (200), returns the created Maskin note object with the transcription:

```json
{
  "id": "abc-123",
  "type": "note",
  "title": "Team standup 2026-03-28",
  "content": "Full transcription text...",
  "metadata": {
    "source": "upload",
    "originalFilename": "standup.mp3",
    "language": "en",
    "duration": 312
  }
}
```

For large files (> ~10 minutes of audio), consider returning a 202 Accepted with a job ID, and letting the client poll for completion. This prevents HTTP timeouts on long transcriptions.

## 6. Recall.ai Integration

### 6.1 API Setup

Store the Recall.ai API key as an environment variable. The extension reads it during initialization:

```
RECALL_API_KEY=your_recall_api_key_here
```

### 6.2 Bot Dispatch Flow

The meeting bot dispatch follows this sequence:

1. Calendar sync detects an upcoming meeting with a video link.
2. Extension creates a Recall bot via `POST /api/v1/bot` with the meeting URL.
3. Recall bot joins the meeting and begins recording.
4. When the meeting ends, Recall sends a webhook to our configured endpoint.
5. Webhook handler downloads the audio from the URL provided by Recall.
6. Audio is passed to the transcription service, and a Maskin note object is created.

### 6.3 Webhook Endpoint

| Property | Value |
|----------|-------|
| Endpoint | `POST /api/extensions/notetaker/webhooks/recall` |
| Auth | Webhook signature verification (Recall signing secret) |
| Trigger | Called by Recall when a recording is complete |

## 7. Calendar Connection

### 7.1 Supported Providers

| Provider | Auth Method | Scopes Required |
|----------|-------------|-----------------|
| Google Calendar | OAuth 2.0 via Google Cloud Console | calendar.readonly, calendar.events.readonly |
| Microsoft Outlook | OAuth 2.0 via Azure AD | Calendars.Read |

### 7.2 Calendar Sync Logic

The calendar sync runs on a configurable interval (default: every 5 minutes) and:

1. Fetches upcoming meetings for the next 30 minutes.
2. Filters based on user preferences (all meetings, only organized by user, specific calendars).
3. Checks for a valid video meeting link (Google Meet, Zoom, Teams URLs).
4. Skips meetings that already have a bot dispatched (deduplication via stored bot IDs).
5. Dispatches a Recall bot for each qualifying meeting.

### 7.3 User Preferences

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-join mode | All meetings | All, only organized by me, or manual selection |
| Language | Auto-detect | Force a specific transcription language or auto-detect |
| Excluded calendars | None | Calendars to skip (e.g., personal calendar) |
| Minimum duration | 5 minutes | Skip very short meetings that are likely reminders |

## 8. Extension Folder Structure

The notetaker extension lives as a single folder within the Maskin extensions directory:

```
extensions/
  notetaker/
    index.ts              # Extension entry point
    config.ts             # Extension configuration
    services/
      transcription.ts    # whisper.cpp HTTP client
      recall.ts           # Recall.ai API client
      calendar.ts         # Calendar sync service
      pipeline.ts         # Wires services together
    routes/
      upload.ts           # Audio upload endpoint
      webhooks.ts         # Recall webhook handler
      settings.ts         # Extension settings API
    types.ts              # Shared TypeScript types
```

## 9. Maskin Object Integration

When a transcription completes (from either the automatic or manual upload flow), the extension creates a Maskin object with the following structure:

| Field | Value | Notes |
|-------|-------|-------|
| `type` | "note" or "insight" | Configurable. Default: note. |
| `title` | Meeting title or filename | From calendar event title or uploaded filename. |
| `content` | Full transcript text | The raw transcription output from whisper.cpp. |
| `metadata.source` | "meeting" or "upload" | Indicates how the audio was captured. |
| `metadata.language` | Detected language | ISO language code returned by whisper.cpp. |
| `metadata.duration` | Duration in seconds | Total audio duration. |
| `metadata.attendees` | Array of names | From calendar event (meeting flow only). |

If a `linkedObjectId` is provided (via upload) or a calendar event can be matched to an existing bet/task, the extension also creates a relationship linking the note to that object.

## 10. Implementation Order

Tasks should be implemented in dependency order. Items in the same phase can be done in parallel.

### Phase 1 — No dependencies (start here)

- Set up whisper.cpp server build and configuration
- Build calendar connection (Google & Outlook OAuth)
- Integrate Recall.ai API for meeting bot dispatch

### Phase 2 — Depends on whisper.cpp server

- Create Docker setup for whisper.cpp sidecar
- Build TypeScript transcription service

### Phase 3 — Depends on TypeScript transcription service

- Build audio file upload endpoint
- Create Maskin object integration for transcriptions

### Phase 4 — Depends on Recall + Calendar + Transcription

- Build automatic meeting-to-transcription pipeline

### Phase 5 — Depends on automatic pipeline

- Build extension onboarding and settings UI
- Test end-to-end flows (both automatic and manual upload)
