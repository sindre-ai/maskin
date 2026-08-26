import { describe, expect, it } from 'vitest'
import { DEFAULT_STALL_THRESHOLD_MS, StallTracker } from '../lib/stall-tracker'

/**
 * The clock is injected, so every threshold assertion here is exact — no fake
 * timers, no sleeps, no flake. Same pattern as guest-log-stream.test.ts.
 */
function makeTracker(thresholdMs = 60_000) {
	let clock = 1_000_000
	const tracker = new StallTracker({ now: () => clock, thresholdMs })
	return {
		tracker,
		advance: (ms: number) => {
			clock += ms
		},
		at: () => clock,
	}
}

const RESULT_LINE = JSON.stringify({ type: 'result', subtype: 'success' })
const ASSISTANT_LINE = JSON.stringify({ type: 'assistant', message: { content: 'thinking' } })

describe('StallTracker — idle is not stalled', () => {
	it('does not count an interactive session with no pending turn, however long it sits', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		tracker.outputObserved('s1', RESULT_LINE)

		// The human walks away for an hour. This is the common case and the whole
		// reason "no output" alone is the wrong predicate.
		advance(60 * 60_000)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 0, no_output: 0 })
	})

	it('does not count a batch session that never takes a turn', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('batch', { interactive: false })
		advance(60 * 60_000)
		expect(tracker.counts().never_seeded).toBe(0)
	})
})

describe('StallTracker — never_seeded (the seedInteractiveTurn shape)', () => {
	it('counts an interactive session that never had a turn enqueued at all', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })

		advance(59_999)
		expect(tracker.counts().never_seeded).toBe(0)
		advance(1)
		expect(tracker.counts()).toEqual({ never_seeded: 1, undelivered: 0, no_output: 0 })
	})

	it('stops counting once any output proves the session is doing something', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.outputObserved('s1', ASSISTANT_LINE)
		advance(60_000)
		expect(tracker.counts().never_seeded).toBe(0)
	})

	it('stops counting once the turn is seeded, however late', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		advance(60_000)
		expect(tracker.counts().never_seeded).toBe(1)

		tracker.turnEnqueued('s1', 1)
		expect(tracker.counts().never_seeded).toBe(0)
	})
})

describe('StallTracker — undelivered (the dead-socket shape)', () => {
	it('counts a turn the guest never acked, after the threshold', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)

		advance(59_999)
		expect(tracker.counts().undelivered).toBe(0)
		advance(1)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 1, no_output: 0 })
	})

	it('does not count a turn still inside the guest re-dial window', () => {
		const { tracker, advance } = makeTracker(DEFAULT_STALL_THRESHOLD_MS)
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		// input-stream.js re-dials after 90s of silence; the default threshold has
		// to clear that comfortably or every healthy turn trips this arm.
		advance(90_000)
		expect(tracker.counts().undelivered).toBe(0)
	})

	it('resets the clock when the ack advances, so a burst of turns is not counted', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		advance(50_000)
		tracker.turnAcked('s1', 1)
		tracker.turnEnqueued('s1', 2)
		advance(50_000)
		// 100s since the first turn, but the guest proved liveness 50s ago.
		expect(tracker.counts().undelivered).toBe(0)
		advance(10_000)
		expect(tracker.counts().undelivered).toBe(1)
	})

	it('ignores a re-dial that repeats the same high-water mark', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		advance(30_000)
		// A guest that reconnects but is consuming nothing sends the same `after`
		// forever. Treating that as liveness would make a blackholed session
		// permanently invisible — the exact wedge this arm exists for.
		tracker.turnAcked('s1', 0)
		advance(30_000)
		expect(tracker.counts().undelivered).toBe(1)
	})
})

describe('StallTracker — no_output (acked, then silence)', () => {
	it('counts a turn that reached the CLI and produced nothing', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)

		advance(60_000)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 0, no_output: 1 })
	})

	it('counts one output line, then silence — output must NOT close the turn', () => {
		// The regression this guards: if `turnPendingSince` were cleared on any
		// output, an agent that emits a single line and then wedges would be
		// invisible forever. That is the 2026-08-21..24 shape — turn delivered,
		// reply started, nothing came back.
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		advance(10_000)
		tracker.outputObserved('s1', ASSISTANT_LINE)

		advance(59_999)
		expect(tracker.counts().no_output).toBe(0)
		advance(1)
		expect(tracker.counts().no_output).toBe(1)
	})

	it('does not count a chatty long tool call — each line resets the clock', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		for (let i = 0; i < 10; i++) {
			advance(30_000)
			tracker.outputObserved('s1', ASSISTANT_LINE)
		}
		// Five minutes of work, never 60s silent.
		expect(tracker.counts().no_output).toBe(0)
	})

	it('closes the turn on the CLI result envelope', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		tracker.outputObserved('s1', RESULT_LINE)
		advance(60 * 60_000)
		expect(tracker.counts().no_output).toBe(0)
	})

	it('treats a non-JSON line mentioning result as ordinary output', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		tracker.outputObserved('s1', '[system] no "result" yet, still working')
		advance(60_000)
		expect(tracker.counts().no_output).toBe(1)
	})

	it('measures the next turn from itself, not from the previous turn output', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		tracker.turnAcked('s1', 1)
		tracker.outputObserved('s1', RESULT_LINE)
		advance(10 * 60_000) // human thinks for ten minutes
		tracker.turnEnqueued('s1', 2)
		tracker.turnAcked('s1', 2)
		// Fresh window: not immediately stalled just because the last output is old.
		expect(tracker.counts().no_output).toBe(0)
		advance(60_000)
		expect(tracker.counts().no_output).toBe(1)
	})
})

describe('StallTracker — lifecycle', () => {
	it('never counts a session after it ends', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('s1', { interactive: true })
		tracker.turnEnqueued('s1', 1)
		advance(60_000)
		expect(tracker.counts().undelivered).toBe(1)

		tracker.endSession('s1')
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 0, no_output: 0 })
		expect(tracker.tracked()).toBe(0)
	})

	it('ignores events for sessions it does not know about', () => {
		const { tracker } = makeTracker()
		tracker.turnEnqueued('ghost', 1)
		tracker.turnAcked('ghost', 1)
		tracker.outputObserved('ghost', ASSISTANT_LINE)
		tracker.endSession('ghost')
		expect(tracker.tracked()).toBe(0)
	})

	it('counts a reattached session as unobserved, never as stalled or healthy', () => {
		// A redeploy erases this process's turn history. Reporting those sessions
		// as fine would be a lie in exactly the moment we care most — we deploy
		// when shipping a fix and want to know whether it worked.
		const { tracker, advance } = makeTracker()
		tracker.trackSession('survivor', { interactive: true, reattached: true })
		advance(60 * 60_000)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 0, no_output: 0 })
		expect(tracker.unobserved()).toBe(1)
		expect(tracker.tracked()).toBe(1)
	})

	it('stops treating a reattached session as unobserved once it takes a turn', () => {
		// The blind spot is a window, not a life sentence. The turn being enqueued
		// here is history THIS process owns, so the arms can judge the session from
		// now on. Without this, a survivor of a redeploy stays exempt from every
		// arm for its whole life (up to SESSION_MAX_DURATION, several deploys) —
		// detection silently off in exactly the deploy-during-an-incident window.
		const { tracker, advance } = makeTracker()
		tracker.trackSession('survivor', { interactive: true, reattached: true })

		tracker.turnEnqueued('survivor', 1)
		expect(tracker.unobserved()).toBe(0)

		// ...and it now wedges: turn enqueued, never acked.
		advance(60_000)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 1, no_output: 0 })
	})

	it('judges a reattached session that reconcile assumed was non-interactive', () => {
		// reconcileOnBoot cannot know whether a survivor is interactive, so it
		// registers `interactive: false`. Taking a turn proves otherwise — and the
		// arms that matter for a wedge must not stay disabled on that stale guess.
		const { tracker, advance } = makeTracker()
		tracker.trackSession('survivor', { interactive: false, reattached: true })

		tracker.turnEnqueued('survivor', 1)
		tracker.turnAcked('survivor', 1)
		advance(60_000)
		expect(tracker.counts()).toEqual({ never_seeded: 0, undelivered: 0, no_output: 1 })
	})
})

describe('StallTracker — counting', () => {
	it('counts each session at most once, under its own arm', () => {
		const { tracker, advance } = makeTracker()
		tracker.trackSession('never', { interactive: true })
		tracker.trackSession('undel', { interactive: true })
		tracker.trackSession('silent', { interactive: true })
		tracker.trackSession('healthy', { interactive: true })

		tracker.turnEnqueued('undel', 1)
		tracker.turnEnqueued('silent', 1)
		tracker.turnAcked('silent', 1)
		tracker.turnEnqueued('healthy', 1)
		tracker.turnAcked('healthy', 1)

		advance(60_000)
		tracker.outputObserved('healthy', RESULT_LINE)

		expect(tracker.counts()).toEqual({ never_seeded: 1, undelivered: 1, no_output: 1 })
		expect(tracker.tracked()).toBe(4)
	})
})
