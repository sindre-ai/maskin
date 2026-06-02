import { describe, expect, it } from 'vitest'
import { isAuthBypassed } from '../app-factory'

describe('isAuthBypassed', () => {
	it('bypasses public discovery endpoints', () => {
		expect(isAuthBypassed('/api/health', 'GET')).toBe(true)
		expect(isAuthBypassed('/api/openapi.json', 'GET')).toBe(true)
	})

	it('bypasses POST /api/actors (signup) but not other methods', () => {
		expect(isAuthBypassed('/api/actors', 'POST')).toBe(true)
		expect(isAuthBypassed('/api/actors', 'GET')).toBe(false)
		expect(isAuthBypassed('/api/actors', 'PATCH')).toBe(false)
	})

	it('bypasses POST /api/auth/login but not other methods', () => {
		expect(isAuthBypassed('/api/auth/login', 'POST')).toBe(true)
		expect(isAuthBypassed('/api/auth/login', 'GET')).toBe(false)
	})

	it('bypasses POST /api/auth/email-change/verify so logged-out email-link clicks reach the handler', () => {
		expect(isAuthBypassed('/api/auth/email-change/verify', 'POST')).toBe(true)
	})

	it('does NOT bypass the email-change request endpoint — that still requires a logged-in caller', () => {
		expect(isAuthBypassed('/api/auth/email-change', 'POST')).toBe(false)
		expect(isAuthBypassed('/api/auth/email-change/cancel', 'POST')).toBe(false)
	})

	it('does NOT bypass GET on the verify path (handler is POST-only)', () => {
		expect(isAuthBypassed('/api/auth/email-change/verify', 'GET')).toBe(false)
	})

	it('bypasses any webhook subpath', () => {
		expect(isAuthBypassed('/api/webhooks/slack', 'POST')).toBe(true)
		expect(isAuthBypassed('/api/webhooks/anything/nested', 'POST')).toBe(true)
	})

	it('bypasses OAuth callback paths but not other integrations paths', () => {
		expect(isAuthBypassed('/api/integrations/google/callback', 'GET')).toBe(true)
		expect(isAuthBypassed('/api/integrations/slack/callback', 'GET')).toBe(true)
		expect(isAuthBypassed('/api/integrations/google/connect', 'POST')).toBe(false)
		expect(isAuthBypassed('/api/integrations', 'GET')).toBe(false)
	})

	it('does not bypass random api paths', () => {
		expect(isAuthBypassed('/api/objects', 'GET')).toBe(false)
		expect(isAuthBypassed('/api/auth/password', 'POST')).toBe(false)
	})
})
