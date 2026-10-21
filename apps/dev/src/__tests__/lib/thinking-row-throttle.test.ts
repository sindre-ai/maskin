import { describe, expect, it } from 'vitest'
import { THINKING_ROW_INTERVAL_MS, ThinkingRowThrottle } from '../../lib/thinking-row-throttle'

const tick = (estimated: number) =>
	JSON.stringify({
		type: 'system',
		subtype: 'thinking_tokens',
		estimated_tokens: estimated,
		estimated_tokens_delta: 1,
	})

describe('ThinkingRowThrottle', () => {
	it('keeps one thinking counter row per interval and never drops other lines', () => {
		const throttle = new ThinkingRowThrottle()
		const session = 'session-a'
		const assistant = JSON.stringify({ type: 'assistant', message: { content: [] } })
		const twoLines = `${tick(1)}\n${tick(2)}\n`

		// A burst of ticks ~50 ms apart: the first is kept, the rest dropped.
		expect(throttle.shouldDrop(session, tick(1), 0)).toBe(false)
		expect(throttle.shouldDrop(session, tick(2), 50)).toBe(true)
		expect(throttle.shouldDrop(session, tick(3), 100)).toBe(true)

		// Other output is never dropped, even mid-burst.
		expect(throttle.shouldDrop(session, assistant, 120)).toBe(false)
		expect(throttle.shouldDrop(session, twoLines, 130)).toBe(false)

		// A pulse comes through once the interval has passed, then it resets.
		expect(throttle.shouldDrop(session, tick(4), THINKING_ROW_INTERVAL_MS)).toBe(false)
		expect(throttle.shouldDrop(session, tick(5), THINKING_ROW_INTERVAL_MS + 50)).toBe(true)

		// Sessions are independent, and forgetting a session starts it fresh.
		expect(throttle.shouldDrop('session-b', tick(1), THINKING_ROW_INTERVAL_MS + 60)).toBe(false)
		throttle.forget(session)
		expect(throttle.shouldDrop(session, tick(6), THINKING_ROW_INTERVAL_MS + 70)).toBe(false)
	})
})
