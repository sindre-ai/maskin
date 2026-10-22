import {
	getStoredSubscriptionId,
	isWebPushSupported,
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
