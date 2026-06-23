import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	__resetSlackMentionDedupForTests,
	shouldEmitSlackMentionMetric,
} from '../../../lib/analytics/slack-mention-dedup'

beforeEach(() => {
	__resetSlackMentionDedupForTests()
})

afterEach(() => {
	__resetSlackMentionDedupForTests()
})

describe('slack-mention-dedup', () => {
	it('emits once for the first sighting of a (workspace, team, message) triple', () => {
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', 1_000_000)).toBe(true)
	})

	it('suppresses a paired envelope arriving within the 1m window', () => {
		const t0 = 1_000_000
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0)).toBe(true)
		// Slack's paired app_mention + message.im land within seconds.
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0 + 3_000)).toBe(false)
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0 + 59_000)).toBe(false)
	})

	it('emits again once the dedup window expires', () => {
		const t0 = 1_000_000
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0)).toBe(true)
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0 + 60_001)).toBe(true)
	})

	it('keeps workspaces independent', () => {
		const t0 = 1_000_000
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0)).toBe(true)
		// Different workspace, same message id — still emits, since the bet's
		// metric distinct id is the workspace.
		expect(shouldEmitSlackMentionMetric('ws-2', 'T_A', 'msg-abc', t0 + 1_000)).toBe(true)
	})

	it('keeps slack teams independent', () => {
		const t0 = 1_000_000
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', 'msg-abc', t0)).toBe(true)
		// Different Slack team can collide on `event.ts` shape across workspaces
		// connected to the same Maskin workspace — keep them separate.
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_B', 'msg-abc', t0 + 1_000)).toBe(true)
	})

	it('falls back to emit when no message id is available', () => {
		// A malformed payload missing both client_msg_id and ts must not
		// silently drop a real mention — over-counting once is the lesser bug.
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', null, 1_000_000)).toBe(true)
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', undefined, 1_000_000)).toBe(true)
		expect(shouldEmitSlackMentionMetric('ws-1', 'T_A', '', 1_000_000)).toBe(true)
	})
})
