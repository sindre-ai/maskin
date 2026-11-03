import { DEFAULT_CHAT_IDLE_CLOSE_MINUTES, resolveChatIdleCloseMs } from '../../config/session-idle'

const MINUTE = 60 * 1000
const INVALID = ['abc', '0', '-3', '2.5', '1441', 'Infinity']

describe('resolveChatIdleCloseMs', () => {
	it('defaults to 15 minutes when unset or blank', () => {
		expect(DEFAULT_CHAT_IDLE_CLOSE_MINUTES).toBe(15)
		expect(resolveChatIdleCloseMs(undefined)).toBe(15 * MINUTE)
		expect(resolveChatIdleCloseMs('  ')).toBe(15 * MINUTE)
	})

	it('uses a valid whole-minute override', () => {
		expect(resolveChatIdleCloseMs('5')).toBe(5 * MINUTE)
		expect(resolveChatIdleCloseMs('1440')).toBe(1440 * MINUTE)
	})

	it.each(INVALID)('falls back to the default for %s', (raw) => {
		expect(resolveChatIdleCloseMs(raw)).toBe(15 * MINUTE)
	})
})
