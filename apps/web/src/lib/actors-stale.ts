// The stream keeps the actors list fresh (actor events refetch it, one per window), so a
// surface that mounts it again shortly after the last load reads the cache instead of asking
// again. Every observer of the list (useActors, the avatar lookup) must use this value: the
// shortest staleTime among the observers on a mount decides whether it refetches.
export const ACTORS_STALE_MS = 5 * 60_000
