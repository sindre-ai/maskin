/**
 * Shared "waiting on viewer" predicate + hook. Both callsites read from this
 * one module so the D3 `AskBanner` (frontend) and the D6 escalation reconciler
 * (`trigger-runner`) can never disagree on what "stalled" means for a loop
 * step.
 *
 * This is the expand slice — the module lands here before D3 / D6 wire up. The
 * `WaitingOnViewerStep` shape below is intentionally structural (a single
 * `waitingOnViewer?: boolean | null` field) so it stays compatible with the
 * fuller `LoopStep` that D6a extends. Anything the callsites already have with
 * that field satisfies the predicate.
 */

export interface WaitingOnViewerStep {
	/**
	 * Per-viewer signal from the API row. Nullable so a partial row (older
	 * server, historical seed data) never trips the predicate — it must be
	 * strictly `true` to be "waiting on viewer".
	 */
	waitingOnViewer?: boolean | null
}

/**
 * Pure predicate. Strict-equality on `true` so any partial / undefined /
 * boolean-coerced value reads as "not waiting". This is the exact rule the D6
 * reconciler applies when scanning `LoopStep WHERE waitingOnViewer = true`.
 */
export function isWaitingOnViewer(step: WaitingOnViewerStep | null | undefined): boolean {
	return step?.waitingOnViewer === true
}

/**
 * Signature for the D3 `AskBanner`. A React app calls this during render with
 * a `loopId` and an accessor that reads the loop's steps from wherever the app
 * already has them (TanStack Query cache in `apps/web`). Passing the accessor
 * keeps this module React-free — `packages/shared` has no React dependency and
 * this file must not add one, since the same file is imported by
 * `trigger-runner` (Node, no React).
 *
 * Named `use*` because the D3 consumer will call it from inside a real React
 * component. Rules-of-hooks apply to *callers*; this function itself does not
 * call any React APIs, so it is safe to unit-test as a plain function.
 */
export type LoopStepsGetter = (loopId: string) => readonly WaitingOnViewerStep[] | null | undefined

export function useWaitingOnViewer(loopId: string, getLoopSteps: LoopStepsGetter): boolean {
	const steps = getLoopSteps(loopId)
	if (!steps || steps.length === 0) return false
	return steps.some(isWaitingOnViewer)
}
