import { classifyTurnError } from '../../lib/turn-error-classifier'

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

	it('defaults to permanent for anything unrecognised', () => {
		// An unknown failure retried automatically is an invisible cost
		// multiplier; reported, it is one message the human can act on.
		expect(classifyTurnError('something nobody has seen before')).toBe('permanent')
	})
})
