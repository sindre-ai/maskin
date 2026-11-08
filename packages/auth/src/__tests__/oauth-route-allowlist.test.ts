import { describe, expect, it } from 'vitest'
import {
	OAUTH_ALLOWED_ROUTES,
	OAUTH_REFUSED_ROUTES,
	classifyOAuthRoute,
	isOAuthRequestAllowed,
} from '../oauth-route-allowlist'

describe('classifyOAuthRoute', () => {
	it('allows a route the MCP tools call', () => {
		expect(classifyOAuthRoute('GET', '/api/objects/:id')).toBe('allowed')
		expect(classifyOAuthRoute('post', '/api/objects')).toBe('allowed')
	})

	it('refuses credential, membership and account routes on purpose', () => {
		expect(classifyOAuthRoute('POST', '/api/actors/:id/api-keys')).toBe('refused')
		expect(classifyOAuthRoute('POST', '/api/workspaces')).toBe('refused')
		expect(classifyOAuthRoute('POST', '/api/actors')).toBe('refused')
		expect(classifyOAuthRoute('POST', '/api/workspaces/:id/members')).toBe('refused')
	})

	it('treats a route nobody classified as unclassified, and the method is part of the key', () => {
		expect(classifyOAuthRoute('GET', '/api/brand-new')).toBe('unclassified')
		expect(classifyOAuthRoute('DELETE', '/api/objects')).toBe('unclassified')
	})

	it('has no route on both lists', () => {
		const refused = new Set(OAUTH_REFUSED_ROUTES)
		expect(OAUTH_ALLOWED_ROUTES.filter((r) => refused.has(r))).toEqual([])
	})

	it('has no duplicate entries', () => {
		const all = [...OAUTH_ALLOWED_ROUTES, ...OAUTH_REFUSED_ROUTES]
		expect(new Set(all).size).toBe(all.length)
	})
})

describe('isOAuthRequestAllowed', () => {
	const route = (method: string, path: string) => ({ method, path })

	it('allows a request whose matched handlers are all allowed', () => {
		expect(
			isOAuthRequestAllowed([
				route('ALL', '/api/*'),
				route('GET', '/api/objects/:id'),
				route('GET', '/api/objects/search'),
			]),
		).toBe(true)
	})

	it('refuses when any matched handler is refused', () => {
		expect(
			isOAuthRequestAllowed([
				route('GET', '/api/objects/:id'),
				route('GET', '/api/objects/secret-thing'),
			]),
		).toBe(false)
	})

	it('refuses a request that matched only middleware or a catch-all', () => {
		expect(isOAuthRequestAllowed([])).toBe(false)
		expect(isOAuthRequestAllowed([route('ALL', '/api/*'), route('GET', '*')])).toBe(false)
	})

	it('refuses a handler registered for every method', () => {
		expect(isOAuthRequestAllowed([route('ALL', '/api/objects')])).toBe(false)
	})
})
