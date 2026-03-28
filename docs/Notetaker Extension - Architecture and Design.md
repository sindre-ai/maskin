# Notetaker Extension — Architecture & Design

**Maskin Platform | March 2026 | Internal — Dev Team**

---

## 1. Overview

The Notetaker Extension is a bundled, opinionated solution for Maskin that gives users automatic meeting transcription out of the box. When enabled, it provides three capabilities: automatic meeting recording via bot dispatch, local audio transcription, and manual audio file upload. All transcription results are stored as Maskin objects (notes/insights) linked to the relevant context.

This extension represents Maskin's built-in notetaker product. Users who prefer third-party tools (Granola, Fireflies, Otter, etc.) connect those as integrations on the integrations page instead — those are separate from this extension and push their own transcripts into Maskin independently.

## 2. Design Principles

- **Single toggle to enable.** Users enable the extension, connect their calendar, and they're done. No configuration required to get started.
- **Local transcription.** Audio is transcribed on our own server using whisper.cpp. No audio data is sent to external transcription APIs.
- **Modular components.** Each component (meeting bot, calendar, transcription) is independently replaceable. Open-source users can swap any piece.
- **Extension vs Integration.** The built-in notetaker is an extension (bundled product). Third-party notetakers are integrations (data bridges). Clear separation of concerns.

## 3. System Architecture

### 3.1 Component Overview

| Component | Responsibility | Technology | Runs As |
|-----------|---------------|------------|---------|
| Transcription Service | Converts audio to text via HTTP API | whisper.cpp | Sidecar process |
| TypeScript Client | Calls transcription service, handles audio routing | TypeScript / fetch | In monolith |
| Meeting Bot Dispatch | Sends recording bots to calendar meetings | Recall.ai API | External API |
| Calendar Connection | Reads user calendar to trigger bot dispatch | Google/Outlook OAuth | In monolith |

### 3.2 Data Flow: Automatic Meeting Transcription

When a user has the extension enabled and their calendar connected, meetings are automatically transcribed through this flow:

1. Calendar sync detects an upcoming meeting with a video link (Google Meet, Zoom, Teams).
2. The system dispatches a Recall.ai bot to join the meeting and record audio.
3. When the meeting ends, Recall sends a webhook with the audio recording URL.
4. The TypeScript client downloads the audio and sends it to whisper-server on localhost.
5. whisper-server transcribes the audio and returns structured JSON.
6. A Maskin note object is created with the transcript, metadata (meeting title, attendees, duration, language), and linked to any relevant context.

### 3.3 Data Flow: Manual Audio Upload

For offline meetings or recordings from other sources, users upload audio files directly:

1. User uploads an audio file (WAV, MP3, M4A, WebM) via the Maskin UI or API.
2. The upload endpoint validates the file (format, size) and passes it to the TypeScript transcription client.
3. The client sends the audio to whisper-server, receives the transcript.
4. A Maskin note object is created with the transcript and source file metadata.

## 4. Component Details

### 4.1 Transcription Service (whisper.cpp)

whisper.cpp is a C/C++ port of OpenAI's Whisper speech recognition model. It runs entirely on CPU with no GPU required, making it suitable for standard server hardware. It ships with a built-in HTTP server (whisper-server) that exposes a `/inference` endpoint accepting audio via multipart form-data and returning JSON transcription results.

| Property | Details |
|----------|---------|
| License | MIT — fully open source, commercial use allowed |
| Hardware | CPU-only. No GPU required. |
| Recommended Model | whisper-small (~500MB RAM) or whisper-medium (~1.5GB RAM) |
| Server Endpoint | POST /inference — multipart form-data with audio file |
| Default Port | 8080 (configurable) |
| Response Format | JSON with transcription text, timestamps, language |
| Features | Timestamps, VAD, language detection, translation, 40+ config parameters |

**Sidecar pattern:** whisper-server runs as a separate process on the same machine as the Maskin monolith. The TypeScript code communicates with it over localhost HTTP. This means no C/C++ knowledge is needed to use it — it's just an HTTP service. In production, it can optionally run in its own Docker container.

### 4.2 Meeting Bot Dispatch (Recall.ai)

Recall.ai is an API service that sends recording bots to video meetings (Google Meet, Zoom, Microsoft Teams). It handles the complexity of joining meetings, capturing audio, and delivering recordings. The Recall brand is never exposed to end users — from their perspective, the extension simply "joins meetings and transcribes them."

**Why Recall.ai (for now):**

- Self-hosting meeting bots is extremely complex (browser automation, WebRTC capture, platform-specific auth). Not worth building now.
- Recall handles all video platform integrations out of the box.
- Can be replaced later with an open-source solution when one matures, without changing the user-facing experience.

### 4.3 Calendar Connection

The calendar connection uses standard OAuth 2.0 flows for Google Calendar and Microsoft Outlook. It reads the user's upcoming meetings to determine which ones to send recording bots to. Users configure their preferences during the extension onboarding flow (e.g., auto-join all meetings, only meetings I organize, or manual selection).

### 4.4 TypeScript Client

The TypeScript transcription client lives inside the Maskin monolith as a module within the extension. It is the internal API that all other parts of the extension use to transcribe audio. It accepts an audio file (Buffer or stream), sends it as multipart form-data to whisper-server, parses the JSON response, and returns a structured transcription result. It includes error handling, retries, timeout configuration, and a health check for the whisper-server connection.

## 5. Extension vs Integrations

A clear architectural boundary separates the built-in notetaker extension from third-party notetaker integrations. This is intentional and should be maintained.

| Aspect | Notetaker Extension | Third-Party Integrations |
|--------|-------------------|------------------------|
| What it is | Maskin's built-in notetaker product | Data bridges to external tools |
| Examples | This extension (Recall + whisper.cpp) | Granola, Fireflies, Otter |
| Transcription | Local, via whisper.cpp | Done by the third-party tool |
| Where in UI | Extensions page | Integrations page |
| Setup | Enable extension, connect calendar | Connect account via OAuth/API key |
| Data ownership | Audio processed locally on our server | Audio processed by the third party |

## 6. Deployment Architecture

### 6.1 Development

In development, everything runs on one machine. The Maskin monolith and whisper-server are started together via a startup script or docker-compose. They communicate over localhost. No containers are required for dev — just two processes running side by side.

### 6.2 Production

In production, the architecture can scale from simple to distributed depending on load:

- **Single server:** Both services on one machine, same as dev. Suitable for low to moderate load (occasional meeting transcriptions).
- **Docker containers:** Separate containers for the monolith and whisper-server via docker-compose. Clean isolation, easy to scale each independently.
- **Separate servers:** whisper-server on a dedicated machine with more CPU. The monolith calls it over internal network instead of localhost. For high-volume transcription workloads.

### 6.3 Server Requirements

| Whisper Model | RAM Needed | Transcription Speed | Recommended For |
|---------------|-----------|---------------------|-----------------|
| tiny | ~75 MB | Very fast | Testing only |
| small | ~500 MB | ~1–2 min per 5 min audio | Starting point |
| medium | ~1.5 GB | ~2–4 min per 5 min audio | Better accuracy |
| large-v3 | ~3 GB | ~4–8 min per 5 min audio | Best accuracy |

Minimum recommended server: 4+ CPU cores, 4–8 GB total RAM (including the monolith and other services). The small or medium model is recommended to start with.

## 7. Open Source vs Hosted Strategy

| Aspect | Hosted (Meshfirm) | Open Source (Self-hosted) |
|--------|-------------------|--------------------------|
| Experience | Easy — enable, connect calendar, done | Configurable — swap any component |
| Meeting bots | Recall.ai (pre-configured) | Recall.ai or bring your own |
| Transcription | whisper.cpp (managed) | whisper.cpp or any compatible backend |
| Configuration | Minimal — sensible defaults | Full control over model, server, and pipeline |

## 8. Security Considerations

- **Audio data stays local.** Transcription happens on our server via whisper.cpp. Audio files are not sent to any third-party transcription service.
- **Recall.ai receives meeting audio.** This is inherent to the meeting bot approach — the bot joins the meeting and captures audio. The audio is then downloaded to our server for transcription. Review Recall's data handling policies.
- **OAuth tokens stored securely.** Calendar OAuth tokens (Google/Outlook) must be encrypted at rest and refreshed properly.
- **whisper-server bound to localhost.** The transcription server should only listen on 127.0.0.1, not exposed to the public internet.

## 9. Future Considerations

- **Open-source meeting bot.** Replace Recall.ai with a self-hosted solution when a mature option becomes available. The modular architecture supports this without user-facing changes.
- **Speaker diarization.** whisper.cpp supports basic timestamps; adding speaker identification (who said what) would be a valuable enhancement.
- **AI-powered meeting notes.** Post-transcription processing to generate meeting summaries, action items, and key decisions using an LLM.
- **Real-time transcription.** Streaming audio to whisper.cpp during a meeting for live captions. This is a significant technical challenge but a strong differentiator.
