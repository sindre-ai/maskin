import { describe, expect, it } from 'vitest'
import { isAllowedWebPushEndpoint, webPushEndpointSchema } from '../schemas/web-push'

describe('isAllowedWebPushEndpoint', () => {
	it.each([
		['Chrome (FCM)', 'https://fcm.googleapis.com/fcm/send/test-token'],
		['Firefox', 'https://updates.push.services.mozilla.com/wpush/v2/test-token'],
		['Firefox, exact host', 'https://push.services.mozilla.com/wpush/v2/test-token'],
		['Safari', 'https://web.push.apple.com/test-token'],
		['Edge on Windows, subdomain', 'https://wns2-par02p.notify.windows.com/w/?token=test-token'],
		['explicit default port', 'https://fcm.googleapis.com:443/fcm/send/test-token'],
		['upper-case host', 'https://FCM.GoogleAPIs.com/fcm/send/test-token'],
	])('accepts %s', (_name, endpoint) => {
		expect(isAllowedWebPushEndpoint(endpoint)).toBe(true)
	})

	it.each([
		['extra labels after an allowed host', 'https://fcm.googleapis.com.attacker.example/x'],
		['no dot before the suffix', 'https://notfcm.googleapis.com/x'],
		['allowed name only in the path', 'https://attacker.example/fcm.googleapis.com/x'],
		['allowed name only in the query', 'https://attacker.example/x?u=push.services.mozilla.com'],
		['allowed name only in the fragment', 'https://attacker.example/x#notify.windows.com'],
		['embedded login', 'https://user:pass@fcm.googleapis.com/x'],
		[
			'allowed host as the login, other host as the target',
			'https://fcm.googleapis.com@127.0.0.1/x',
		],
		['custom port', 'https://fcm.googleapis.com:8443/x'],
		['http', 'http://fcm.googleapis.com/x'],
		['other scheme', 'wss://fcm.googleapis.com/x'],
		['IPv4', 'https://10.0.0.5/x'],
		['cloud metadata IP', 'https://169.254.169.254/latest/meta-data'],
		['IPv6 loopback', 'https://[::1]/x'],
		['localhost', 'https://localhost/x'],
		['internal name', 'https://postgres.internal/x'],
		['not a URL', 'fcm.googleapis.com'],
	])('rejects %s', (_name, endpoint) => {
		expect(isAllowedWebPushEndpoint(endpoint)).toBe(false)
	})
})

describe('webPushEndpointSchema', () => {
	it('accepts an allowed endpoint', () => {
		expect(
			webPushEndpointSchema.safeParse('https://fcm.googleapis.com/fcm/send/test-token').success,
		).toBe(true)
	})

	it('rejects a host that is not a push service', () => {
		expect(
			webPushEndpointSchema.safeParse('https://fcm.googleapis.com.attacker.example/x').success,
		).toBe(false)
	})

	it('keeps the 2048-character limit', () => {
		const long = `https://fcm.googleapis.com/${'a'.repeat(2048)}`
		expect(webPushEndpointSchema.safeParse(long).success).toBe(false)
	})
})
