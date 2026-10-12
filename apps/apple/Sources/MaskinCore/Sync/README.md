# Sync: on-disk cache, freshness, foreground/connectivity refresh

Goal: the app always opens on the user's real, last-known data, then quietly catches up. No
spinners on a repeat launch, no blank screen offline, and a failed refresh never erases good data.

## Pieces

| Type | File | Job |
|------|------|-----|
| `DiskCache` | `DiskCache.swift` | Generic, versioned, Codable on-disk cache keyed by (actorId, workspaceId, name). |
| `SnapshotCache` | `SnapshotCache.swift` | What a store holds: a `DiskCache` bound to "current actor / current workspace". |
| `Freshness` | `Freshness.swift` | Value a store exposes: source (none / cache / network), last-updated time, last refresh failed. |
| `SyncCoordinator` | `SyncCoordinator.swift` | Foreground refresh, connectivity (`isOnline`), outbox replay on reconnect, coalescing. |
| `SyncLog` | `SyncLog.swift` | `os.Logger` (`io.maskin.app`; categories `sync`, `cache`, `network`). |
| `.freshnessFooter` / `.syncOfflineBanner` | `MaskinFeatures/Sync/FreshnessIndicator.swift` | The unobtrusive "Updated 3 min ago" line and the one global offline banner. |

## What is cached

| Store | Cache name | Scope | Content | Not cached |
|-------|-----------|-------|---------|-----------|
| `ForYouStore` | `foryou.feed` | actor + workspace | up to 100 cards + sender names | decisions in flight, the daily brief |
| `ObjectsStore` | `objects.list` | actor + workspace | the UNFILTERED first page (<= 50) | filtered/searched lists, later pages |
| `ObjectDetailStore` | `object.<id>` | actor + workspace | the object and its links | activity stream (comment text) |
| `LoopsStore` | `loops.list` | actor + workspace | loops + the names their rows show | steps, activity, install flags |
| `TriggersStore` | `triggers.list` | actor + workspace | triggers + agent names | |
| `AgentsStore` | `agents.list` | actor + workspace | agent summaries with latest session | agent detail, session logs |
| `WorkspaceStore` | `workspaces.list` | actor only | workspace list | selection (lives in `AuthSession`) |

Chats are intentionally not here (`chat-final` owns them and follows this README).

## Lifecycle of a cached store

1. `init(…, cache:)` calls `hydrateIfNeeded()`: when the store is empty and the cache has an
   entry for the CURRENT actor and workspace, it fills itself, sets `phase = .loaded` and
   `freshness.hydrated(from:)`. The first frame already shows real data.
2. `load()`/`start()` calls `hydrateIfNeeded()` again (the session may be restored after init)
   and then revalidates. Revalidation of cached data must NOT show a spinner.
3. On success: replace the data, `freshness.refreshed(at:)`, write the snapshot.
4. On failure: keep the data, `freshness.revalidateFailed()`. Only an EMPTY store shows an error.
5. `reset()` (workspace switch, sign-out) clears memory and `freshness`; the next load hydrates
   from the new bucket.

## TTLs, bounds, invalidation

- Entries expire after 14 days (`Limits.maxAge`), are rejected above 4 MB each, and the whole
  cache is bounded at 24 MB; past that the least-recently-used entries are evicted.
- A `version` mismatch (bump it when a cached type changes shape), a corrupt file or a decode
  failure discards the entry and is reported as a miss. Never a crash, never a throw.
- Server truth always wins: the cache is only ever the first frame, never a substitute for a fetch.
- Sign-out: `DiskCache.clearAll()` (static; works even if no instance exists yet).
- Workspace deleted: `DiskCache.shared.clear(workspaceId:)`. One actor: `clear(actorId:)`.

## Privacy

- Stores cache what their screen shows, nothing more: no credentials, no API keys, no message
  bodies beyond a row's own snippet. Comment/chat history is not cached.
- Per-actor directories are named by a one-way hash, so actor B can never read actor A's files and
  hostile ids cannot escape the directory. Tests prove both.
- Stored under Application Support (not Caches, not iCloud): the directory is excluded from
  backup and files use complete-until-first-user-authentication protection on iOS/watchOS/tvOS.
- Logs never contain tokens, message text, names or raw ids: only fixed names, counts, durations
  and `SyncLog.shortHash` fingerprints.

## Refresh triggers (`SyncCoordinator`)

- Returning to the foreground after >= 45 s away: one coalesced `EventHub.requestRefresh()`
  (the existing `.reconnected` signal, which every store already handles).
- Regaining connectivity: refresh (coalesced: at most one per 5 s, so a flapping link refreshes
  once) and the outbox drains (every time; the outbox serialises itself).
- Offline: no refreshes are sent; `isOnline` drives the single global banner.
- Live SSE events keep refetching per store as before; an SSE reconnect also reloads.

## Adopting it in a store

```swift
public init(…, cache: SnapshotCache? = nil) { …; self.cache = cache; hydrateIfNeeded() }

struct Snapshot: Codable, Sendable { var rows: [Row] }       // view-sized, no secrets
private func hydrateIfNeeded() {
    guard phase == .idle, rows.isEmpty, let e = cache?.read(Snapshot.self, "feature.list") else { return }
    rows = e.value.rows; phase = .loaded; freshness.hydrated(from: e.savedAt)
}
// after a successful fetch:  freshness.refreshed(at: cache?.now() ?? Date()); cache?.write(Snapshot(…), "feature.list")
// in the catch:              freshness.revalidateFailed(); if rows.isEmpty { phase = .failed(…) }
```

Model types need `Codable` (add it on the declaration; synthesis does not work from another
file). Wiring: pass `environment.snapshotCache`. In the view: `.freshnessFooter(store.freshness,
isOnline: sync.isOnline)`.

Each adopting store gets four regression tests (see `Tests/MaskinCoreTests/Sync/StoreCacheTests.swift`):
cached data is there before any await; revalidate replaces it; a failed revalidate keeps it;
another actor sees nothing.
