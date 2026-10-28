# Rolling back the agent-base image

Use this when a new `agent-base` image breaks sessions (or a guarded MCP server
must stop launching) and the quickest safe fix is the previous image rather than
a forward fix. Owner: Infra & DevOps.

## What a rollback is

`agent-base-docker.yml` pushes every merge that touches `docker/agent-base/**` as
`<AGENT_BASE_IMAGE>:latest` plus `:sha-<short>`. Sessions run `:latest`. Rolling
back means pointing `:latest` at an older `sha-*` tag and restarting
`maskin-agent-server` so new sessions launch on it.

## How far back it reaches

The deploy workflow prunes `sha-*` tags down to the newest 10 after each push, so
a rollback reaches back about 10 merges to `docker/agent-base/**`. Docker Hub is
the source of truth: open the tag list for the `AGENT_BASE_IMAGE` repository and
use a tag that is there. On 2026-10-17 it listed 14 `sha-*` tags (newest
`sha-cb4e0c5`, oldest `sha-89360e9` from 2026-08-24), so the prune is looser than
"10", but do not rely on a tag more than about 10 builds old. If the tag you need
is gone, rebuild from that commit instead (revert on `main`, which redeploys).

## Do it (GitHub Actions)

1. Pick the target: the `sha-*` tag built before the bad change. `:latest` always
   equals the newest `sha-*` tag, so the target is the one before it.
2. Actions > Roll back agent-base image > Run workflow (branch `main`): tag =
   `sha-xxxxxxx`, restart = on.
3. The run summary prints the digest `:latest` had, and the digest it has now.
   The job fails if `:latest` does not equal the target afterwards, or if the
   restart fails (the deploy workflow's restart is `continue-on-error`; this one
   is not).
4. Confirm on a real session (below). A green run alone is not confirmation.

Roll forward the same way, with the newer `sha-*` tag.

Manual fallback, if Actions is down and someone holds the Docker Hub and host
credentials: `docker buildx imagetools create -t <image>:latest <image>:sha-xxxxxxx`,
then `ssh <host> systemctl restart maskin-agent-server`.

## The tested rollback in the BYO merge window

The rollback is tested once, after the aggregate bet PR merges, inside the
02:00 to 04:00 UTC window. The workflow cannot run earlier: it only runs once it
is on `main`, and before the merge `:latest` is the pre-wrapper image, so a
rollback would change nothing. Order:

1. Before the merge, post the running-session count and the digest of `:latest`
   on the wrapper task. Note the pre-wrapper `sha-*` tag.
2. Merge. Confirm the wrapper version line in a session that started after the
   restart.
3. Roll back to the pre-wrapper tag. Start a new session and confirm it launches
   and the guarded server does not start (see "Confirm it worked").
4. Roll forward to the new `sha-*` tag. Confirm the wrapper version line again.
5. Post both pieces of evidence on the rollout task.

Hard stop: if the roll-forward is not confirmed by 03:45 UTC, do it by hand with
the manual fallback above. Never leave the window on the pre-wrapper image. Hold
every other merge touching `docker/agent-base/**` during the window. If another
change to that folder (for example the AWS CLI line) lands in the same window, it
rides the roll-forward, not a third restart.

## What the restart does (read from `apps/agent-server`, not yet observed on the host)

- Running sessions keep running. The unit uses `KillMode=process`, so microVMs
  survive the restart, and `reconcileOnBoot` re-attaches them. They keep the
  image they started on; only sessions created after the restart get the new one.
- `POST /sessions` answers 503 while the server drains and re-attaches. A
  dispatch in that window is retried by the dispatcher.
- New sessions get the new `:latest` because the image warmer runs
  `msb create --pull always` at boot (when `WARM_POOL_IMAGE` is set on the host)
  and sessions otherwise pull `always`. `WARM_POOL_REFRESH_MINUTES` re-pulls on a
  timer. The host's `.env` was not readable from CI, so which of these applies is
  unverified until a post-restart session shows the new image.

## Confirm it worked

Open the log of a session that started after the restart. Do not use a session
that was already running at the restart: it keeps the old image.

On an image with the wrapper, the launch script prints one line at start:
`[system] maskin-mcp-guard version: <x>`.

On a pre-wrapper tag there is no wrapper line at all. Its launch script has no
version log and no drop step, so the log says nothing about the wrapper. The
guard is enforced only because the `maskin-mcp-guard` command does not exist
there: a guarded server cannot start, and the extension is refused. Confirm a
rollback to a pre-wrapper tag with both of these:

- the `maskin-mcp-guard version:` line is absent from the new session's log, and
- a guarded server does not start in that session (it is not in the session's
  running MCP servers, and its tools are not callable).

That is the fail-closed behaviour working, not a second fault. The line
`[system] maskin-mcp-guard not available in this image: ...` (and
`WARNING: MCP server '<name>' dropped ...`) appears only on a newer launch script
paired with an image whose wrapper is missing or broken, not on a pre-wrapper tag.

## Gotchas

- The next merge to `main` touching `docker/agent-base/**` builds a new `:latest`
  and overwrites the rollback, then restarts the server. Hold such merges until
  the forward fix is ready.
- Merges to `docker/agent-base/**` and rollback restarts land inside the
  02:00 to 04:00 UTC window unless it is an incident.
- This does not cover the browser-sidecar image (`browser-sidecar-docker.yml`).
