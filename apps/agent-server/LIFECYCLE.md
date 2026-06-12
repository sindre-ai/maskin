# agent-server — session lifecycle (stop / snapshot / restore)

Three HTTP endpoints + a host-local snapshot store sit on top of the
existing `/agent` host directory model. They pair with T8's S3 persistence
but operate purely on the bare-metal host — S3 backup of snapshot tarballs
is out of scope for v1 per the bet's chosen direction.

## Endpoints

The routes live in `src/routes/sessions-lifecycle.ts`. T2 mounts them on
the main Hono app once it stands up the agent-server entry point.

| Method | Path                          | Purpose                                                   |
| ------ | ----------------------------- | --------------------------------------------------------- |
| POST   | `/sessions/:id/stop`          | Gracefully halt the running microVM (`msb remove -f`).    |
| POST   | `/sessions/:id/snapshot`      | Pack the session's `/agent` host path into a new tarball. |
| POST   | `/sessions/:id/restore`       | Boot a fresh microVM from a snapshot, same sessionId.     |

## Identity contract — what gets persisted vs. re-derived

The disk-only model is intentionally narrow about what crosses the
stop→restore boundary.

**Persisted on disk** (survives `stop` and lives on the host until the
next restore):

- `<sessionDirRoot>/<sessionId>/` — the entire `/agent` bind-mount tree
  (workspace, skills, learnings, memory, anything the agent wrote).
- `<snapshotsRoot>/<sessionId>/<snapshotId>.tar.gz` — the snapshot
  artefact. The most recent one is the default for restore.

**Re-derived on restore** (the caller re-supplies; not persisted):

- `image` — the OCI image to boot. Required on every restore.
- `env` — fresh credentials and config. Required on every restore;
  secrets may have rotated since the original spawn.
- `memoryMib`, `cpus`, `maxDurationSecs` — optional, default to the
  agent-server's configured defaults.

**Preserved by convention** (no body field, never changes):

- `sessionId` — the same id flows through stop, snapshot, restore, and
  is reused as the sandbox name.
- `sandboxName === sessionId` — single-tenant per-session naming.
- Bind-mount target — always `<sessionDirRoot>/<sessionId>` → `/agent`.

## Wiring it into the main server (T2)

```ts
import { Hono } from 'hono'
import { createSessionsLifecycleRoutes } from './routes/sessions-lifecycle'
import { MsbCliImpl } from './services/msb-cli'
import { SessionLifecycle } from './services/session-lifecycle'
import { SnapshotStore } from './services/snapshot-store'

const lifecycle = new SessionLifecycle(
  new MsbCliImpl(),
  new SnapshotStore(process.env.MASKIN_SNAPSHOTS_ROOT ?? '/var/lib/maskin/snapshots'),
  {
    sessionDirRoot: process.env.MASKIN_SESSION_DIR_ROOT ?? '/agent/sessions',
    defaultMemoryMib: Number(process.env.MASKIN_DEFAULT_MEMORY_MIB ?? 2048),
    defaultCpus: Number(process.env.MASKIN_DEFAULT_CPUS ?? 2),
  },
)

const app = new Hono()
app.route('/sessions', createSessionsLifecycleRoutes(lifecycle))
```

`HOST_SETUP.md §5` pre-creates `<sessionDirRoot>` on the box; T2 (or
follow-on) should pre-create `<snapshotsRoot>` next to it.

## Sharing primitives with T2's spawn endpoint

`src/lib/env-sanitizer.ts` (libkrun ASCII strip + >1500-char overflow
spill) and `src/services/msb-cli.ts` (typed wrapper around the `msb` CLI)
are reusable. T2's spawn endpoint should call the same `MsbCli.create()`
and `sanitizeEnvForLibkrun()` so the two surfaces stay aligned with the
bet's operational constraints #1, #2.

## Out of scope for T3

- S3 backup of snapshot tarballs.
- A scheduled background snapshotter (disk-only snapshots happen on the
  explicit stop→snapshot call only).
- A session registry keyed on sandboxId. Identity flows through
  `sessionId` alone, derived by convention.
- DB persistence of snapshot metadata — the file system is the source of
  truth at v1. T5's `agent_servers` table is separate.
