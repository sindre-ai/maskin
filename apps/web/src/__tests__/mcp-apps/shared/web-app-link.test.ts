import { buildWebAppPath } from '@/mcp-apps/shared/web-app-link'
import { describe, expect, it } from 'vitest'

describe('buildWebAppPath', () => {
	const ws = 'ws-123'

	it('builds workspace root for pulse and workspace targets', () => {
		expect(buildWebAppPath(ws, { kind: 'workspace' })).toBe('/ws-123')
		expect(buildWebAppPath(ws, { kind: 'pulse' })).toBe('/ws-123')
	})

	it('builds object detail path', () => {
		expect(buildWebAppPath(ws, { kind: 'object', id: 'obj-9' })).toBe('/ws-123/objects/obj-9')
	})

	it('builds trigger list and detail paths', () => {
		expect(buildWebAppPath(ws, { kind: 'trigger' })).toBe('/ws-123/triggers')
		expect(buildWebAppPath(ws, { kind: 'trigger', id: 't-1' })).toBe('/ws-123/triggers/t-1')
	})

	it('builds agent list and detail paths', () => {
		expect(buildWebAppPath(ws, { kind: 'agent' })).toBe('/ws-123/agents')
		expect(buildWebAppPath(ws, { kind: 'agent', id: 'a-1' })).toBe('/ws-123/agents/a-1')
	})

	it('builds activity path', () => {
		expect(buildWebAppPath(ws, { kind: 'activity' })).toBe('/ws-123/activity')
	})

	it('builds settings index and section paths', () => {
		expect(buildWebAppPath(ws, { kind: 'settings' })).toBe('/ws-123/settings')
		expect(buildWebAppPath(ws, { kind: 'settings', section: 'keys' })).toBe('/ws-123/settings/keys')
	})
})
