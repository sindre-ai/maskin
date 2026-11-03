import type { ErrorEvent } from '@sentry/node'
import { describe, expect, it } from 'vitest'
import { DEDUPE_WINDOW_MS, NOISY_MESSAGES, createSentryDedupe } from '../../lib/sentry-dedupe'

const TITLE = 'Claude OAuth token refresh failed'

function setup() {
	let clock = 1_000_000
	const dedupe = createSentryDedupe(DEDUPE_WINDOW_MS, () => clock)
	const advance = (ms: number) => {
		clock += ms
	}
	return { dedupe, advance }
}

const event = (message: string | undefined, rest: Partial<ErrorEvent> = {}): ErrorEvent =>
	({ type: undefined, message, ...rest }) as ErrorEvent

describe('createSentryDedupe', () => {
	it('lets the first event through and drops repeats inside the hour', () => {
		const { dedupe, advance } = setup()
		const first = event(TITLE, { tags: { workspace_id: 'ws-1' } })
		expect(dedupe(first)).toBe(first)
		advance(DEDUPE_WINDOW_MS - 1)
		expect(dedupe(event(TITLE, { tags: { workspace_id: 'ws-1' } }))).toBeNull()
	})

	it('lets one through again once the hour has passed', () => {
		const { dedupe, advance } = setup()
		dedupe(event(TITLE, { tags: { workspace_id: 'ws-1' } }))
		advance(DEDUPE_WINDOW_MS)
		expect(dedupe(event(TITLE, { tags: { workspace_id: 'ws-1' } }))).not.toBeNull()
	})

	it('does not extend the window with dropped repeats', () => {
		const { dedupe, advance } = setup()
		dedupe(event(TITLE))
		advance(DEDUPE_WINDOW_MS - 1)
		expect(dedupe(event(TITLE))).toBeNull()
		advance(1)
		expect(dedupe(event(TITLE))).not.toBeNull()
	})

	it('keeps a separate key per workspace id (tag or extra)', () => {
		const { dedupe } = setup()
		expect(dedupe(event(TITLE, { tags: { workspace_id: 'ws-1' } }))).not.toBeNull()
		expect(dedupe(event(TITLE, { tags: { workspace_id: 'ws-2' } }))).not.toBeNull()
		expect(dedupe(event(TITLE, { extra: { workspaceId: 'ws-3' } }))).not.toBeNull()
		expect(dedupe(event(TITLE, { extra: { workspaceId: 'ws-3' } }))).toBeNull()
		expect(dedupe(event(TITLE, { tags: { workspace_id: 'ws-1' } }))).toBeNull()
	})

	it('keeps a separate key per message', () => {
		const { dedupe } = setup()
		expect(dedupe(event('Claude session died on a 401'))).not.toBeNull()
		expect(dedupe(event(TITLE))).not.toBeNull()
		expect(dedupe(event(TITLE))).toBeNull()
	})

	it('never touches other messages or events without one', () => {
		const { dedupe } = setup()
		for (let i = 0; i < 3; i++) {
			expect(dedupe(event('Something else broke'))).not.toBeNull()
			expect(dedupe(event(undefined))).not.toBeNull()
		}
	})

	it('covers the five top repeat errors', () => {
		expect([...NOISY_MESSAGES]).toHaveLength(5)
		const { dedupe } = setup()
		for (const message of NOISY_MESSAGES) {
			expect(dedupe(event(message))).not.toBeNull()
			expect(dedupe(event(message))).toBeNull()
		}
	})
})
