import {
	classifyTurnError,
	extractCloudflareRayId,
	isProviderBlockPage,
} from '../../lib/turn-error-classifier'

describe('classifyTurnError', () => {
	it('reads an Anthropic 500 as transient', () => {
		expect(
			classifyTurnError(
				'API Error: {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_1"}',
			),
		).toBe('transient')
	})

	it('reads an overload as transient', () => {
		expect(classifyTurnError('{"type":"overloaded_error"}')).toBe('transient')
	})

	it('reads a network fault as transient', () => {
		expect(classifyTurnError('fetch failed: socket hang up')).toBe('transient')
	})

	it('reads a quota banner as permanent', () => {
		expect(classifyTurnError("You've hit your weekly limit")).toBe('permanent')
		expect(classifyTurnError('Credit balance is too low')).toBe('permanent')
	})

	it('reads an auth failure as permanent', () => {
		expect(classifyTurnError('{"type":"authentication_error"}')).toBe('permanent')
	})

	it('prefers permanent when a quota banner also mentions a server fault', () => {
		// Order matters: retrying an exhausted plan just burns the same failure
		// twice and delays the message that explains it.
		expect(classifyTurnError("You've hit your limit — api_error while retrying")).toBe('permanent')
	})

	it('reads a Cloudflare 403 block page as transient, not an auth failure', () => {
		const text = 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare'
		expect(isProviderBlockPage(text)).toBe(true)
		expect(classifyTurnError(text)).toBe('transient')
	})

	it('does not read a real 401 or a plain 403 as a block page', () => {
		const unauthorized =
			'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'
		expect(isProviderBlockPage(unauthorized)).toBe(false)
		expect(classifyTurnError(unauthorized)).toBe('permanent')
		expect(isProviderBlockPage('API Error: 403 {"error":{"message":"forbidden"}}')).toBe(false)
	})

	it('pulls the Ray ID out of block-page text when it is there', () => {
		const page = '<p>Cloudflare Ray ID: <strong>8f3a1b2c4d5e6f70</strong></p>'
		expect(extractCloudflareRayId(page)).toBe('8f3a1b2c4d5e6f70')
		expect(extractCloudflareRayId('403 Attention Required! | Cloudflare')).toBeNull()
	})

	it('defaults to permanent for anything unrecognised', () => {
		// An unknown failure retried automatically is an invisible cost
		// multiplier; reported, it is one message the human can act on.
		expect(classifyTurnError('something nobody has seen before')).toBe('permanent')
	})
})
