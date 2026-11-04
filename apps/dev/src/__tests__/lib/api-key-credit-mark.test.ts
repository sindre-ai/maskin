import type { Database } from '@maskin/db'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

import {
	API_KEY_CREDIT_MARK_WINDOW_MS,
	checkApiKeyCreditMark,
	fingerprintStoredKey,
	markApiKeyOutOfCredit,
} from '../../lib/api-key-credit-mark'

const KEY = 'sealed:abc123'
const AT = 1_000_000

function settingsWithMark(mark: unknown) {
	return { llm_keys: { anthropic: KEY }, anthropic_key_out_of_credit: mark }
}

describe('checkApiKeyCreditMark', () => {
	it('is out of credit inside the window for the same key', () => {
		const settings = settingsWithMark({ at: AT, key: fingerprintStoredKey(KEY) })
		expect(checkApiKeyCreditMark(settings, KEY, AT + 1)).toEqual({
			outOfCredit: true,
			stale: null,
		})
		expect(
			checkApiKeyCreditMark(settings, KEY, AT + API_KEY_CREDIT_MARK_WINDOW_MS - 1).outOfCredit,
		).toBe(true)
	})

	it('is back in service at exactly 30 minutes, and the mark is stale', () => {
		const mark = { at: AT, key: fingerprintStoredKey(KEY) }
		const result = checkApiKeyCreditMark(
			settingsWithMark(mark),
			KEY,
			AT + API_KEY_CREDIT_MARK_WINDOW_MS,
		)
		expect(result).toEqual({ outOfCredit: false, stale: mark })
	})

	it('ignores a mark for a different key, and calls it stale', () => {
		const mark = { at: AT, key: fingerprintStoredKey('sealed:other') }
		const result = checkApiKeyCreditMark(settingsWithMark(mark), KEY, AT + 1)
		expect(result).toEqual({ outOfCredit: false, stale: mark })
	})

	it('treats no mark, or a malformed one, as in service', () => {
		for (const settings of [
			{},
			null,
			settingsWithMark(undefined),
			settingsWithMark('yes'),
			settingsWithMark({ at: 'now', key: 'x' }),
		]) {
			expect(checkApiKeyCreditMark(settings, KEY, AT)).toEqual({
				outOfCredit: false,
				stale: null,
			})
		}
	})
})

describe('markApiKeyOutOfCredit', () => {
	it('never throws, so a failure path is not made worse by it', async () => {
		const db = {
			update: vi.fn(() => {
				throw new Error('connection reset')
			}),
		} as unknown as Database
		await expect(markApiKeyOutOfCredit({ db, workspaceId: 'ws-1' })).resolves.toBe(false)
	})
})
