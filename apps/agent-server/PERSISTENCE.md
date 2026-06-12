# agent-server — `/agent` persistence

S3 is the durable store for each session's `/agent` workspace. The pull/push
pair in `src/services/session-workspace.ts` is the wire-in surface for T2's
spawn flow and T3's stop/snapshot path.

## Layout

- S3 key: `agent-workspaces/<sessionId>.tar.gz` — one tar.gz per session.
- Host path: `/agent/sessions/<sessionId>/` — extracted tree, bind-mounted as
  `/agent` into the microVM (see `HOST_SETUP.md §5`).
- The four subdirs the agent harness reads — `workspace/`, `skills/`,
  `learnings/`, `memory/` — are guaranteed to exist on the host before the
  pull function returns, even on a first boot with no archive in S3. This is
  bet operational constraint #3 — without these dirs on the host, the
  bind-mount wipes WORKDIR and libkrun panics.

## How T2 wires it in (spawn)

Before `msb create`:

```ts
import { pullSessionWorkspace } from './services/session-workspace'

const sessionDir = `/agent/sessions/${sessionId}`
const { restored } = await pullSessionWorkspace(storage, sessionId, sessionDir)
logger.info('session workspace pulled', { sessionId, restored })

// then: msb create ... --volume `${sessionDir}:/agent`
```

## How T3 wires it in (stop/snapshot)

After the sandbox is gracefully halted:

```ts
import { pushSessionWorkspace } from './services/session-workspace'

const sessionDir = `/agent/sessions/${sessionId}`
const { archiveBytes } = await pushSessionWorkspace(storage, sessionId, sessionDir)
logger.info('session workspace pushed', { sessionId, archiveBytes })
```

The pair is idempotent: calling `pushSessionWorkspace` twice in a row produces
two uploads with the same content (last-write-wins on the S3 key). Calling
`pullSessionWorkspace` after `push` extracts the latest upload.

## Out of scope for T8

- Wiring into the spawn/stop endpoints — T2 and T3.
- Pre-creating `/agent/sessions/` on the host — already in `HOST_SETUP.md §5`.
- A worker that snapshots running sessions on a timer — disk-only snapshots
  on pause/stop only, per the chosen direction.
- GC / TTL on `agent-workspaces/*` keys — future task.
