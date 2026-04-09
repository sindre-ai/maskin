import { describe, expect, it } from 'vitest'
import { templateSchema, validateTemplate } from '../schemas/templates'
import type { Template } from '../schemas/templates'

const minimalTemplate: Template = {
	name: 'Test Template',
	description: 'A test template',
	version: '1.0.0',
	extensions: [],
	agents: [],
	triggers: [],
}

const fullTemplate: Template = {
	name: 'Product Development',
	description: 'Sprint planning, backlog grooming, release tracking',
	version: '1.0.0',
	extensions: [
		{
			id: 'product_dev',
			name: 'Product Development',
			object_types: [
				{
					type: 'sprint',
					display_name: 'Sprint',
					icon: 'timer',
					statuses: ['planning', 'active', 'completed'],
					fields: [
						{ name: 'goal', type: 'text', required: true },
						{ name: 'velocity', type: 'number', required: false },
					],
				},
				{
					type: 'story',
					display_name: 'Story',
					icon: 'book-open',
					statuses: ['backlog', 'ready', 'in_progress', 'done'],
					fields: [
						{
							name: 'priority',
							type: 'enum',
							required: true,
							values: ['critical', 'high', 'medium', 'low'],
						},
						{ name: 'points', type: 'number', required: false },
					],
				},
			],
		},
	],
	agents: [
		{
			$id: 'standup_agent',
			name: 'Standup Bot',
			system_prompt: 'You summarize daily standups.',
			llm_provider: 'anthropic',
		},
		{
			$id: 'blocker_agent',
			name: 'Blocker Detector',
			system_prompt: 'You detect blocked items.',
			llm_provider: 'anthropic',
		},
	],
	triggers: [
		{
			name: 'Daily Standup',
			type: 'cron' as const,
			config: { expression: '0 9 * * 1-5' },
			action_prompt: 'Summarize standup',
			target_agent: 'standup_agent',
			enabled: true,
		},
		{
			name: 'Blocker Alert',
			type: 'event' as const,
			config: {
				entity_type: 'story',
				action: 'status_changed',
				to_status: 'blocked',
			},
			action_prompt: 'A story was blocked. Investigate.',
			target_agent: 'blocker_agent',
			enabled: true,
		},
	],
	seed: {
		nodes: [
			{
				$id: 'sprint_1',
				type: 'sprint',
				title: 'Sprint 1',
				content: 'First sprint',
				status: 'planning',
				metadata: { goal: 'Initial setup' },
			},
			{
				$id: 'story_1',
				type: 'story',
				title: 'Setup CI/CD',
				status: 'backlog',
				metadata: { priority: 'high', points: 3 },
			},
		],
		edges: [
			{
				source: 'sprint_1',
				target: 'story_1',
				type: 'breaks_into',
			},
		],
	},
}

describe('templateSchema', () => {
	it('accepts a minimal template', () => {
		const result = templateSchema.parse(minimalTemplate)
		expect(result.name).toBe('Test Template')
		expect(result.version).toBe('1.0.0')
		expect(result.extensions).toEqual([])
		expect(result.agents).toEqual([])
		expect(result.triggers).toEqual([])
	})

	it('accepts a full template with all sections', () => {
		const result = templateSchema.parse(fullTemplate)
		expect(result.name).toBe('Product Development')
		expect(result.extensions).toHaveLength(1)
		expect(result.extensions[0].object_types).toHaveLength(2)
		expect(result.agents).toHaveLength(2)
		expect(result.triggers).toHaveLength(2)
		expect(result.seed?.nodes).toHaveLength(2)
		expect(result.seed?.edges).toHaveLength(1)
	})

	it('defaults version to 1.0.0', () => {
		const { version, ...rest } = minimalTemplate
		const result = templateSchema.parse(rest)
		expect(result.version).toBe('1.0.0')
	})

	it('defaults empty arrays for optional sections', () => {
		const result = templateSchema.parse({
			name: 'Bare',
			description: 'Bare template',
		})
		expect(result.extensions).toEqual([])
		expect(result.agents).toEqual([])
		expect(result.triggers).toEqual([])
	})

	it('rejects missing name', () => {
		expect(() => templateSchema.parse({ description: 'no name' })).toThrow()
	})

	it('rejects invalid version format', () => {
		expect(() => templateSchema.parse({ ...minimalTemplate, version: 'v1' })).toThrow()
	})

	it('rejects extension id with invalid characters', () => {
		expect(() =>
			templateSchema.parse({
				...minimalTemplate,
				extensions: [
					{
						id: 'Invalid-ID',
						name: 'Bad',
						object_types: [{ type: 'x', display_name: 'X', statuses: ['a'] }],
					},
				],
			}),
		).toThrow()
	})

	it('rejects object type with no statuses', () => {
		expect(() =>
			templateSchema.parse({
				...minimalTemplate,
				extensions: [
					{
						id: 'ext',
						name: 'Ext',
						object_types: [{ type: 'thing', display_name: 'Thing', statuses: [] }],
					},
				],
			}),
		).toThrow()
	})

	it('accepts cron trigger', () => {
		const result = templateSchema.parse({
			...minimalTemplate,
			agents: [{ $id: 'a', name: 'A', system_prompt: 'Do stuff' }],
			triggers: [
				{
					name: 'Daily',
					type: 'cron',
					config: { expression: '0 9 * * *' },
					action_prompt: 'Run daily',
					target_agent: 'a',
				},
			],
		})
		expect(result.triggers[0].type).toBe('cron')
	})

	it('accepts event trigger with optional fields', () => {
		const result = templateSchema.parse({
			...minimalTemplate,
			agents: [{ $id: 'a', name: 'A', system_prompt: 'Do stuff' }],
			triggers: [
				{
					name: 'On Create',
					type: 'event',
					config: {
						entity_type: 'task',
						action: 'created',
						filter: { status: 'new' },
						from_status: 'todo',
						to_status: 'done',
					},
					action_prompt: 'Handle creation',
					target_agent: 'a',
				},
			],
		})
		const trigger = result.triggers[0]
		expect(trigger.type).toBe('event')
		if (trigger.type === 'event') {
			expect(trigger.config.filter).toEqual({ status: 'new' })
		}
	})

	it('defaults agent llm_provider to anthropic', () => {
		const result = templateSchema.parse({
			...minimalTemplate,
			agents: [{ $id: 'a', name: 'A', system_prompt: 'Do stuff' }],
		})
		expect(result.agents[0].llm_provider).toBe('anthropic')
	})
})

describe('validateTemplate', () => {
	it('returns no errors for a valid full template', () => {
		const errors = validateTemplate(fullTemplate)
		expect(errors).toEqual([])
	})

	it('returns no errors for a minimal template', () => {
		const errors = validateTemplate(minimalTemplate)
		expect(errors).toEqual([])
	})

	it('detects trigger referencing unknown agent', () => {
		const template: Template = {
			...minimalTemplate,
			agents: [{ $id: 'real_agent', name: 'A', system_prompt: 'x', llm_provider: 'anthropic' }],
			triggers: [
				{
					name: 'Bad Trigger',
					type: 'cron',
					config: { expression: '0 * * * *' },
					action_prompt: 'Do stuff',
					target_agent: 'nonexistent_agent',
					enabled: true,
				},
			],
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].path).toBe('triggers[0].target_agent')
		expect(errors[0].message).toContain('nonexistent_agent')
	})

	it('detects duplicate agent $ids', () => {
		const template: Template = {
			...minimalTemplate,
			agents: [
				{ $id: 'dup', name: 'A', system_prompt: 'x', llm_provider: 'anthropic' },
				{ $id: 'dup', name: 'B', system_prompt: 'y', llm_provider: 'anthropic' },
			],
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].message).toContain('Duplicate agent $id')
	})

	it('detects seed node with unknown type', () => {
		const template: Template = {
			...minimalTemplate,
			seed: {
				nodes: [{ $id: 'n1', type: 'nonexistent_type', status: 'new' }],
				edges: [],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].message).toContain('unknown type "nonexistent_type"')
	})

	it('allows seed nodes using built-in types', () => {
		const template: Template = {
			...minimalTemplate,
			seed: {
				nodes: [
					{ $id: 'i1', type: 'insight', status: 'new' },
					{ $id: 'b1', type: 'bet', status: 'signal' },
					{ $id: 't1', type: 'task', status: 'todo' },
				],
				edges: [],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toEqual([])
	})

	it('allows seed nodes using template-defined extension types', () => {
		const template: Template = {
			...minimalTemplate,
			extensions: [
				{
					id: 'crm',
					name: 'CRM',
					object_types: [
						{ type: 'lead', display_name: 'Lead', icon: 'user', statuses: ['new', 'qualified'] },
					],
				},
			],
			seed: {
				nodes: [{ $id: 'l1', type: 'lead', status: 'new' }],
				edges: [],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toEqual([])
	})

	it('detects duplicate seed node $ids', () => {
		const template: Template = {
			...minimalTemplate,
			seed: {
				nodes: [
					{ $id: 'dup', type: 'task', status: 'todo' },
					{ $id: 'dup', type: 'task', status: 'todo' },
				],
				edges: [],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].message).toContain('Duplicate seed node $id')
	})

	it('detects edge referencing unknown source', () => {
		const template: Template = {
			...minimalTemplate,
			seed: {
				nodes: [{ $id: 'n1', type: 'task', status: 'todo' }],
				edges: [{ source: 'unknown', target: 'n1', type: 'blocks' }],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].path).toBe('seed.edges[0].source')
	})

	it('detects edge referencing unknown target', () => {
		const template: Template = {
			...minimalTemplate,
			seed: {
				nodes: [{ $id: 'n1', type: 'task', status: 'todo' }],
				edges: [{ source: 'n1', target: 'unknown', type: 'blocks' }],
			},
		}
		const errors = validateTemplate(template)
		expect(errors).toHaveLength(1)
		expect(errors[0].path).toBe('seed.edges[0].target')
	})

	it('reports multiple errors at once', () => {
		const template: Template = {
			...minimalTemplate,
			agents: [
				{ $id: 'dup', name: 'A', system_prompt: 'x', llm_provider: 'anthropic' },
				{ $id: 'dup', name: 'B', system_prompt: 'y', llm_provider: 'anthropic' },
			],
			triggers: [
				{
					name: 'Bad',
					type: 'cron',
					config: { expression: '* * * * *' },
					action_prompt: 'x',
					target_agent: 'ghost',
					enabled: true,
				},
			],
			seed: {
				nodes: [{ $id: 's1', type: 'fake_type', status: 'x' }],
				edges: [{ source: 's1', target: 'missing', type: 'blocks' }],
			},
		}
		const errors = validateTemplate(template)
		expect(errors.length).toBeGreaterThanOrEqual(3)
	})
})
