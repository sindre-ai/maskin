import {
	getStoredSubscriptionId,
	isChatTag,
	isWebPushSupported,
	pushTagsOf,
	staleNotifications,
	storeSubscriptionId,
	toSubscribeBody,
	urlBase64ToUint8Array,
} from '@/lib/web-push'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
	vi.unstubAllGlobals()
	localStorage.clear()
})

describe('urlBase64ToUint8Array', () => {
	it('decodes URL-safe base64 with missing padding', () => {
		// "hello?>" encodes to "aGVsbG8_Pg" (URL-safe, unpadded)
		expect(Array.from(urlBase64ToUint8Array('aGVsbG8_Pg'))).toEqual([
			104, 101, 108, 108, 111, 63, 62,
		])
	})

	it('decodes a 65-byte VAPID public key to its raw length', () => {
		const key = `B${'A'.repeat(86)}`
		expect(urlBase64ToUint8Array(key)).toHaveLength(65)
	})
})

describe('subscription id storage', () => {
	it('round-trips and clears', () => {
		expect(getStoredSubscriptionId()).toBeNull()
		storeSubscriptionId('abc')
		expect(getStoredSubscriptionId()).toBe('abc')
		storeSubscriptionId(null)
		expect(getStoredSubscriptionId()).toBeNull()
	})

	it('does not throw when storage is blocked', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
			removeItem: () => {
				throw new Error('blocked')
			},
		})
		expect(getStoredSubscriptionId()).toBeNull()
		expect(() => storeSubscriptionId('abc')).not.toThrow()
	})
})

describe('toSubscribeBody', () => {
	const sub = (json: object) => ({ toJSON: () => json }) as unknown as PushSubscription

	it('maps a browser subscription to the API body', () => {
		const body = toSubscribeBody(
			sub({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'pk', auth: 'ak' } }),
		)
		expect(body).toMatchObject({
			endpoint: 'https://push.example.com/x',
			keys: { p256dh: 'pk', auth: 'ak' },
		})
		expect(body.user_agent.length).toBeLessThanOrEqual(512)
	})

	it('throws on an incomplete subscription rather than sending a broken one', () => {
		expect(() => toSubscribeBody(sub({ endpoint: 'https://push.example.com/x' }))).toThrow()
	})
})

describe('isWebPushSupported', () => {
	it('is false when the browser has no PushManager (e.g. Safari not installed to home screen)', () => {
		// jsdom ships none of serviceWorker / PushManager / Notification.
		expect(isWebPushSupported()).toBe(false)
	})
})

describe('pushTagsOf', () => {
	it('returns the id when there is no collapse key', () => {
		expect(pushTagsOf({ id: 'n1', metadata: null })).toEqual(['n1'])
		expect(pushTagsOf({ id: 'n1', metadata: { push_collapse_key: '  ' } })).toEqual(['n1'])
	})

	it('adds the trimmed collapse key, which is what the server tags the push with', () => {
		expect(pushTagsOf({ id: 'n1', metadata: { push_collapse_key: ' ask:42 ' } })).toEqual([
			'n1',
			'ask:42',
		])
	})
})

describe('isChatTag', () => {
	it('matches the chat, its threads and its mentions', () => {
		expect(isChatTag('chat:c1', 'c1')).toBe(true)
		expect(isChatTag('chat:c1:thread:7', 'c1')).toBe(true)
		expect(isChatTag('chat-mention:c1:99', 'c1')).toBe(true)
	})

	it('does not match another conversation that shares a prefix', () => {
		expect(isChatTag('chat:c10', 'c1')).toBe(false)
		expect(isChatTag('chat-mention:c10:1', 'c1')).toBe(false)
		expect(isChatTag('n1', 'c1')).toBe(false)
	})
})

describe('staleNotifications', () => {
	const shown = (tag: string, url?: string) => ({
		tag,
		data: url ? { url } : undefined,
		close() {},
	})

	it('keeps pending ones and returns the rest of this workspace', () => {
		const pending = shown('n1', '/w1/notifications')
		const handled = shown('n2', '/w1/chats/c1')
		expect(staleNotifications([pending, handled], 'w1', new Set(['n1']))).toEqual([handled])
	})

	it('leaves other workspaces, unreadable links and untagged ones alone', () => {
		const other = shown('n3', '/w2/notifications')
		const noLink = shown('n4')
		const untagged = shown('', '/w1/notifications')
		expect(staleNotifications([other, noLink, untagged], 'w1', new Set())).toEqual([])
	})
})
