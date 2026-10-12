---
title: Live mode protocol
slug: live-protocol
description: The REST and WebSocket protocol for a live (voice) conversation with an agent, for clients that are not TypeScript.
last_updated: 2026-10-12
---

# Live mode protocol

Live mode is a hands-free voice conversation with a workspace agent. The server streams the agent's reply from OpenRouter, runs its tools, and speaks the answer through OpenRouter text-to-speech. A client sends text it has already recognised and plays back the audio it receives. Protocol version: **1**.

The source of truth is [`packages/shared/src/schemas/live.ts`](../../packages/shared/src/schemas/live.ts). If this page and that file disagree, the file wins and this page is wrong.

## Lifecycle

1. `POST /api/live-sessions` creates a session and returns the WebSocket path.
2. Open the WebSocket. The server sends `ready`.
3. Exchange frames. End with an `end` frame or `POST /api/live-sessions/{id}/end`.

All requests carry `Authorization: Bearer ank_…` and `X-Workspace-Id`. A native client can set both on the WebSocket upgrade. A browser cannot set headers on an upgrade, so web needs the single-use ticket, which is not built yet.

Everything is behind the `live-mode` feature flag. A caller who does not have it gets `404`, never `403`.

## REST

### `POST /api/live-sessions`

```json
{ "agent_id": "<uuid>", "conversation_id": "<uuid, optional>", "input_mode": "audio", "opening": "briefing" }
```

`opening: "briefing"` makes the agent begin by walking through the day's brief.

Response `201`: `{ live_session, ws_url, protocol_version: 1 }`. `ws_url` is a path; resolve it against the API base URL and switch `http(s)` to `ws(s)`.

| Status | Meaning |
|---|---|
| 400 | The agent is not live-enabled, or `X-Workspace-Id` is missing |
| 402 | The workspace's plan usage cap is reached |
| 404 | Flag off, agent not in this workspace, or conversation not found |
| 409 | The caller already has a live call, or the workspace has no OpenRouter credentials |
| 429 | The workspace used its live minutes for today. Body has `retry_after_seconds` |

### `GET /api/live-sessions/{id}`

The session, if it is the caller's. Anyone else's is a `404`.

### `POST /api/live-sessions/{id}/end`

Idempotent. Returns the final state: status, duration, total cost in USD, turn count and the conversation id.

### `POST /api/actors/{id}/live-mode`

Workspace admins only. `{ "enabled": true, "voice": "alloy" }`. Omit `voice` to keep it, send `null` to clear it. Actor list and detail responses carry `live: { enabled, voice }`.

## WebSocket

`GET /api/live-sessions/{id}/stream`. Text frames are JSON objects with a `type`. Binary frames carry audio.

A client must ignore a frame `type` it does not know. The server may add new ones.

### Binary frames

A 12-byte little-endian header, then PCM.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | version, `1` |
| 1 | 1 | kind: `1` assistant audio, `2` user audio |
| 2 | 2 | reserved, `0` |
| 4 | 4 | turn index |
| 8 | 4 | sequence, starting at `0` for each turn |

Payload is 16-bit signed little-endian PCM, mono. The sample rate comes from the turn's `audio.start` frame. Drop any frame whose turn index is not the one you are playing: it belongs to a turn that was interrupted.

### Client to server

| `type` | Fields | Meaning |
|---|---|---|
| `hello` | `protocol_version`, `client` (`ios`/`web`/`watch`), `speak` | Optional first frame. `speak: false` asks for text only |
| `turn.text` | `client_turn_id`, `text`, `interrupt` (default `true`) | The person said this. A running turn is interrupted unless `interrupt` is `false` |
| `interrupt` | `turn_index`, `played_seq` | Stop the turn. `played_seq` is the last audio sequence the client actually played, so the server knows what was heard |
| `confirm` | `confirmation_id`, `approved` | Tap answer to a `tool.confirm_required` |
| `context.object` | `object_id` | The person pulled an item up on screen. The next turn sees it |
| `ping` | | Send every 15 seconds |
| `end` | `reason` | End the call |
| `turn.audio.start` / `turn.audio.end` | | Server-side speech recognition. **Not enabled yet**: the server replies with an `stt_failed` error |

### Server to client

| `type` | Fields | Meaning |
|---|---|---|
| `ready` | `live_session_id`, `conversation_id`, `agent`, `llm_model`, `tts`, `persist_transcripts`, `resume` | The socket is live |
| `transcript.user` | `turn_index`, `text`, `message_id` | Echo of the person's turn. Not sent for the synthetic opening line |
| `turn.started` | `turn_index` | |
| `assistant.delta` | `turn_index`, `text` | Raw text as the model writes it. Use for captions |
| `assistant.sentence` | `turn_index`, `sentence_index`, `text` | The cleaned sentence about to be spoken |
| `audio.start` | `turn_index`, `format`, `sample_rate`, `channels`, `bits_per_sample` | Once per turn, before the first audio frame |
| `audio.sentence_end` | `turn_index`, `sentence_index`, `last_seq` | Every frame of that sentence has been sent |
| `audio.end` | `turn_index`, `last_seq` | All audio for the turn has been sent |
| `tool.started` / `tool.finished` | `turn_index`, `call_id`, `label`, `ok` | The agent is using a tool. `label` is plain wording, never an id |
| `tool.confirm_required` | `confirmation_id`, `label`, `summary`, `expires_at` | The agent wants to do something that changes data and is waiting for a yes |
| `object.pulled_up` | `object_id`, `object_type`, `title`, `status` | The agent showed an item |
| `turn.finished` | `turn_index`, `message_id`, `interrupted`, `usage`, `duration_ms` | The turn is over |
| `pong` | | |
| `error` | `code`, `message` | See below |
| `ended` | `reason` | The call is over. The server closes the socket |

Order within a turn: `turn.started`, `transcript.user`, then deltas, sentences, tool frames and audio interleaved, then `audio.end`, then `turn.finished`. Nothing arrives for a turn after its `turn.finished`.

### Errors

`invalid_message`, `turn_in_progress`, `plan_cap_exceeded`, `llm_failed`, `tts_failed`, `stt_failed`, `tool_failed`, `audio_too_long`, `client_stalled`, `unsupported_protocol`. `plan_cap_exceeded` is followed by `ended` with reason `plan_cap`.

### Interrupting

Send `interrupt` as soon as the person speaks over the agent, stop playback, and discard buffered frames. The server aborts the model request and the speech requests, saves only the sentences the client reports it played (`played_seq`) as the message, and keeps the full text in the message's metadata.

### Keepalive and reconnecting

Send `ping` every 15 seconds. The server closes a socket that has been silent for 45 seconds. If the socket drops, reconnect to the same path within 20 seconds and the call continues. A turn that was running is saved as interrupted and is not resumed. After 20 seconds the call ends as `network_error`.

### Backpressure

The server stops sending audio while the socket's send buffer holds more than 1 MiB and drops the client after 10 seconds without progress, with `client_stalled`.

## Where the conversation goes

Both sides of every turn are saved as messages in a conversation, tagged `source: "live"`, so a call appears in Chats like any other thread. A workspace can switch this off with `settings.live.persist_transcripts = false`.
