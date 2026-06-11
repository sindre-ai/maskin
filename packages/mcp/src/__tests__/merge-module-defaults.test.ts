import type { ModuleDefinition } from '@maskin/module-sdk'
import { clearModules, registerModule } from '@maskin/module-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { mergeEnabledModuleDefaults } from '../server'

const workModule: ModuleDefinition = {
	id: 'work',
	name: 'Work',
	version: '0.1.0',
	objectTypes: [
		{ type: 'bet', label: 'Bet', icon: 'target', defaultStatuses: ['active'] },
		{ type: 'task', label: 'Task', icon: 'check', defaultStatuses: ['todo'] },
	],
	defaultSettings: {
		display_names: { bet: 'Bet', task: 'Task' },
		statuses: { bet: ['active', 'done'], task: ['todo', 'done'] },
		field_definitions: { bet: [{ name: 'priority', type: 'text' }] },
		relationship_types: ['breaks_into', 'blocks'],
	},
}

const crmModule: ModuleDefinition = {
	id: 'crm',
	name: 'CRM',
	version: '0.1.0',
	objectTypes: [
		{ type: 'contact', label: 'Contact', icon: 'user', defaultStatuses: ['new_lead'] },
		{ type: 'company', label: 'Company', icon: 'building-2', defaultStatuses: ['prospect'] },
	],
	defaultSettings: {
		display_names: { contact: 'Contact', company: 'Company' },
		statuses: { contact: ['new_lead', 'converted'], company: ['prospect', 'customer'] },
		field_definitions: {
			contact: [{ name: 'email', type: 'text' }],
			company: [{ name: 'website', type: 'text' }],
		},
		relationship_types: ['relates_to', 'works_at', 'decision_maker_at'],
	},
}

describe('mergeEnabledModuleDefaults', () => {
	beforeEach(() => {
		clearModules()
		registerModule(workModule)
		registerModule(crmModule)
	})

	afterEach(() => {
		clearModules()
	})

	it('fills in display_names/statuses/field_definitions for module-provided types', () => {
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['work', 'crm'],
		})

		expect(result.display_names).toEqual({
			bet: 'Bet',
			task: 'Task',
			contact: 'Contact',
			company: 'Company',
		})
		expect(result.statuses).toEqual({
			bet: ['active', 'done'],
			task: ['todo', 'done'],
			contact: ['new_lead', 'converted'],
			company: ['prospect', 'customer'],
		})
		expect(result.field_definitions).toEqual({
			bet: [{ name: 'priority', type: 'text' }],
			contact: [{ name: 'email', type: 'text' }],
			company: [{ name: 'website', type: 'text' }],
		})
	})

	it('preserves existing template entries (existing wins over module defaults)', () => {
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['work', 'crm'],
			display_names: { bet: 'Custom Bet Name' },
			statuses: { bet: ['custom_status'] },
			field_definitions: { bet: [{ name: 'custom_field', type: 'text' }] },
		})

		expect((result.display_names as Record<string, string>).bet).toBe('Custom Bet Name')
		expect((result.statuses as Record<string, string[]>).bet).toEqual(['custom_status'])
		expect((result.field_definitions as Record<string, unknown[]>).bet).toEqual([
			{ name: 'custom_field', type: 'text' },
		])
		// Untouched module-provided types still get filled in
		expect((result.display_names as Record<string, string>).contact).toBe('Contact')
	})

	it('merges relationship_types with dedupe across template and modules', () => {
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['work', 'crm'],
			relationship_types: ['breaks_into', 'derived_from', 'works_at'],
		})

		const relTypes = result.relationship_types as string[]
		expect(new Set(relTypes)).toEqual(
			new Set([
				'breaks_into',
				'blocks',
				'derived_from',
				'relates_to',
				'works_at',
				'decision_maker_at',
			]),
		)
		expect(relTypes.length).toBe(new Set(relTypes).size)
	})

	it('silently skips unknown module ids', () => {
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['work', 'nonexistent_module', 'crm'],
		})

		expect((result.display_names as Record<string, string>).bet).toBe('Bet')
		expect((result.display_names as Record<string, string>).contact).toBe('Contact')
	})

	it('defaults to ["work"] when enabled_modules is missing', () => {
		const result = mergeEnabledModuleDefaults({})

		expect((result.display_names as Record<string, string>).bet).toBe('Bet')
		expect((result.display_names as Record<string, string>).contact).toBeUndefined()
	})

	it('returns empty merged structures when no enabled module contributes', () => {
		clearModules()
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['unknown'],
		})

		expect(result.display_names).toEqual({})
		expect(result.statuses).toEqual({})
		expect(result.field_definitions).toEqual({})
		expect(result.relationship_types).toEqual([])
	})

	it('preserves unrelated settings keys (custom_extensions, enabled_modules)', () => {
		const result = mergeEnabledModuleDefaults({
			enabled_modules: ['work', 'crm'],
			custom_extensions: { foo: { name: 'Foo', types: ['bar'], enabled: true } },
		})

		expect(result.enabled_modules).toEqual(['work', 'crm'])
		expect(result.custom_extensions).toEqual({
			foo: { name: 'Foo', types: ['bar'], enabled: true },
		})
	})
})
