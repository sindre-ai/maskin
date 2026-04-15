import { describe, expect, it } from 'vitest'
import {
	describeCron,
	formatActor,
	formatActorList,
	formatConfirmation,
	formatDashboard,
	formatEvent,
	formatEventList,
	formatExtension,
	formatExtensionList,
	formatIntegrationList,
	formatNotification,
	formatNotificationList,
	formatObject,
	formatObjectGraph,
	formatObjectList,
	formatProviderList,
	formatRelationshipList,
	formatSchema,
	formatSession,
	formatSessionList,
	formatTrigger,
	formatTriggerList,
	formatWorkspace,
	formatWorkspaceList,
	timeAgo,
	truncate,
} from '../formatters'

describe('helpers', () => {
	describe('timeAgo', () => {
		it('returns empty for falsy input', () => {
			expect(timeAgo(null)).toBe('')
			expect(timeAgo(undefined)).toBe('')
			expect(timeAgo('')).toBe('')
		})

		it('returns "just now" for recent timestamps', () => {
			expect(timeAgo(new Date().toISOString())).toBe('just now')
		})

		it('returns minutes ago', () => {
			const d = new Date(Date.now() - 5 * 60 * 1000).toISOString()
			expect(timeAgo(d)).toBe('5m ago')
		})

		it('returns hours ago', () => {
			const d = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
			expect(timeAgo(d)).toBe('3h ago')
		})

		it('returns days ago', () => {
			const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
			expect(timeAgo(d)).toBe('2d ago')
		})

		it('returns empty for invalid date', () => {
			expect(timeAgo('not-a-date')).toBe('')
		})
	})

	describe('truncate', () => {
		it('returns empty for falsy input', () => {
			expect(truncate(null)).toBe('')
			expect(truncate(undefined)).toBe('')
		})

		it('returns text unchanged if under limit', () => {
			expect(truncate('hello', 10)).toBe('hello')
		})

		it('truncates with ellipsis', () => {
			expect(truncate('hello world', 5)).toBe('hello...')
		})

		it('collapses newlines', () => {
			expect(truncate('line1\nline2\nline3', 50)).toBe('line1 line2 line3')
		})
	})

	describe('describeCron', () => {
		it('converts every-N-minutes pattern', () => {
			expect(describeCron('*/5 * * * *')).toBe('every 5 min')
			expect(describeCron('*/15 * * * *')).toBe('every 15 min')
		})

		it('converts daily pattern', () => {
			expect(describeCron('0 9 * * *')).toBe('daily at 09:00')
			expect(describeCron('30 14 * * *')).toBe('daily at 14:30')
		})

		it('converts weekday pattern', () => {
			expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 09:00')
		})

		it('converts weekly pattern', () => {
			expect(describeCron('0 9 * * 1')).toBe('weekly on Mon at 09:00')
			expect(describeCron('0 10 * * 0')).toBe('weekly on Sun at 10:00')
		})

		it('converts monthly pattern', () => {
			expect(describeCron('0 9 1 * *')).toBe('monthly on the 1st at 09:00')
			expect(describeCron('0 9 2 * *')).toBe('monthly on the 2nd at 09:00')
			expect(describeCron('0 9 3 * *')).toBe('monthly on the 3rd at 09:00')
			expect(describeCron('0 9 15 * *')).toBe('monthly on the 15th at 09:00')
		})

		it('falls back to raw expression for unknown patterns', () => {
			expect(describeCron('0 9 1-15 * *')).toBe('0 9 1-15 * *')
			expect(describeCron('not-a-cron')).toBe('not-a-cron')
		})
	})
})

describe('formatObject', () => {
	it('formats a basic object', () => {
		const result = formatObject({
			title: 'My Bet',
			type: 'bet',
			status: 'active',
			id: 'abc-123',
		})
		expect(result).toContain('📄 My Bet')
		expect(result).toContain('Type:    bet')
		expect(result).toContain('Status:  active')
		expect(result).toContain('ID:      abc-123')
	})

	it('shows owner when present', () => {
		const result = formatObject({
			title: 'Test',
			type: 'task',
			status: 'todo',
			ownerId: 'actor-123',
		})
		expect(result).toContain('Owner:   actor-123')
	})

	it('includes content preview', () => {
		const result = formatObject({
			title: 'Test',
			type: 'insight',
			status: 'new',
			content: 'This is a long description of the insight.',
		})
		expect(result).toContain('Content:')
		expect(result).toContain('This is a long description')
	})

	it('shows metadata', () => {
		const result = formatObject({
			title: 'Test',
			type: 'task',
			status: 'todo',
			metadata: { priority: 'high', effort: 'large' },
		})
		expect(result).toContain('Metadata:')
		expect(result).toContain('priority: high')
		expect(result).toContain('effort: large')
	})

	it('handles untitled objects', () => {
		const result = formatObject({ type: 'bet', status: 'active' })
		expect(result).toContain('📄 Untitled')
	})
})

describe('formatObjectGraph', () => {
	it('formats object with relationships', () => {
		const result = formatObjectGraph({
			object: { id: 'obj-1', title: 'Main', type: 'bet', status: 'active' },
			relationships: [
				{ type: 'breaks_into', sourceId: 'obj-1', targetId: 'obj-2' },
				{ type: 'informs', sourceId: 'obj-3', targetId: 'obj-1' },
			],
			connected: [
				{ id: 'obj-2', title: 'Sub task', type: 'task', status: 'todo' },
				{ id: 'obj-3', title: 'Research', type: 'insight', status: 'new' },
			],
		})
		expect(result).toContain('📄 Main')
		expect(result).toContain('Relationships (2)')
		expect(result).toContain('→ breaks_into: Sub task (task, todo)')
		expect(result).toContain('← informs: Research (insight, new)')
	})
})

describe('formatObjectList', () => {
	it('shows empty state with guidance', () => {
		const result = formatObjectList([])
		expect(result).toContain('No objects found')
		expect(result).toContain('create_objects')
	})

	it('shows search query in empty state with guidance', () => {
		const result = formatObjectList([], { query: 'test' })
		expect(result).toContain('No objects matching "test"')
		expect(result).toContain('list_objects')
	})

	it('formats list of objects with IDs', () => {
		const result = formatObjectList([
			{ id: 'abcd1234-5678-9012-3456-789012345678', type: 'bet', status: 'active', title: 'Bet 1' },
			{ id: 'efgh5678-1234-5678-9012-345678901234', type: 'task', status: 'todo', title: 'Task 1' },
		])
		expect(result).toContain('📋 Objects (2 results)')
		expect(result).toContain('abcd1234')
		expect(result).toContain('efgh5678')
		expect(result).toContain('bet')
		expect(result).toContain('task')
		expect(result).toContain('Bet 1')
		expect(result).toContain('Task 1')
	})

	it('shows pagination info', () => {
		const result = formatObjectList([{ type: 'bet', status: 'active', title: 'X' }], {
			offset: 10,
			total: 50,
		})
		expect(result).toContain('Showing 11–11 of 50')
	})
})

describe('formatEventList', () => {
	it('shows empty state', () => {
		expect(formatEventList([])).toContain('No recent activity')
	})

	it('formats events', () => {
		const result = formatEventList([
			{
				action: 'created',
				entity_type: 'object',
				actor_name: 'Alice',
				metadata: { title: 'My Bet' },
			},
		])
		expect(result).toContain('Recent Activity')
		expect(result).toContain('Alice')
		expect(result).toContain('created')
		expect(result).toContain('"My Bet"')
	})
})

describe('formatActor', () => {
	it('formats actor details', () => {
		const result = formatActor({ name: 'Alice', type: 'human', role: 'owner', email: 'a@b.com' })
		expect(result).toContain('👤 Alice')
		expect(result).toContain('Type:  human')
		expect(result).toContain('Role:  owner')
		expect(result).toContain('Email: a@b.com')
	})

	it('shows agent-specific fields', () => {
		const result = formatActor({
			name: 'Bot',
			type: 'agent',
			system_prompt: 'You are a helpful assistant',
			tools: { search: {}, create: {} },
			llm_provider: 'claude-code',
		})
		expect(result).toContain('Prompt:')
		expect(result).toContain('You are a helpful assistant')
		expect(result).toContain('Tools:  search, create')
		expect(result).toContain('LLM:   claude-code')
	})

	it('does not show agent fields for humans', () => {
		const result = formatActor({
			name: 'Alice',
			type: 'human',
			system_prompt: 'ignored',
		})
		expect(result).not.toContain('Prompt:')
	})

	it('shows API key warning when present', () => {
		const result = formatActor({
			name: 'Bot',
			type: 'agent',
			api_key: 'ank_test123',
		})
		expect(result).toContain('ank_test123')
		expect(result).toContain('shown only once')
	})
})

describe('formatActorList', () => {
	it('shows empty state with guidance', () => {
		const result = formatActorList([])
		expect(result).toContain('No team members')
		expect(result).toContain('create_actor')
	})

	it('formats team list with IDs', () => {
		const result = formatActorList([
			{ id: 'actor-1-uuid', name: 'Alice', type: 'human', role: 'owner' },
			{ id: 'actor-2-uuid', name: 'Bot', type: 'agent', role: 'member' },
		])
		expect(result).toContain('Team (2 members)')
		expect(result).toContain('Alice — human (owner)')
		expect(result).toContain('Bot — agent (member)')
		expect(result).toContain('id: actor-1-uuid')
		expect(result).toContain('id: actor-2-uuid')
	})
})

describe('formatSession', () => {
	it('formats session details', () => {
		const result = formatSession({
			id: 'sess-1',
			status: 'running',
			action_prompt: 'Fix the bug',
		})
		expect(result).toContain('🤖 Session — running')
		expect(result).toContain('Fix the bug')
	})

	it('shows status icons for terminal states', () => {
		expect(formatSession({ status: 'completed' })).toContain('completed ✓')
		expect(formatSession({ status: 'failed' })).toContain('failed ✗')
		expect(formatSession({ status: 'timeout' })).toContain('timeout ⏱')
	})

	it('shows container config when present', () => {
		const result = formatSession({
			status: 'running',
			config: { timeout_seconds: 300, memory_mb: 1024, runtime: 'claude-code' },
		})
		expect(result).toContain('Config:')
		expect(result).toContain('timeout: 300s')
		expect(result).toContain('memory: 1024MB')
		expect(result).toContain('runtime: claude-code')
	})

	it('shows elapsed time for terminal sessions', () => {
		const start = new Date('2025-01-01T00:00:00Z')
		const end = new Date('2025-01-01T00:04:32Z')
		const result = formatSession({
			status: 'completed',
			created_at: start.toISOString(),
			updated_at: end.toISOString(),
		})
		expect(result).toContain('Elapsed: 4m 32s')
	})

	it('includes logs when provided', () => {
		const result = formatSession({ status: 'completed' }, [
			{ message: 'Starting...', stream: 'stdout' },
			{ message: 'Error!', stream: 'stderr' },
		])
		expect(result).toContain('Logs')
		expect(result).toContain('> Starting...')
		expect(result).toContain('⚠ Error!')
	})
})

describe('formatSessionList', () => {
	it('shows empty state with guidance', () => {
		const result = formatSessionList([])
		expect(result).toContain('No sessions found')
		expect(result).toContain('create_session')
	})

	it('includes session IDs', () => {
		const result = formatSessionList([
			{ id: 'abcd1234-5678', status: 'running', action_prompt: 'Fix bugs' },
		])
		expect(result).toContain('abcd1234')
		expect(result).toContain('running')
		expect(result).toContain('Fix bugs')
	})
})

describe('formatTrigger', () => {
	it('formats cron trigger with human-readable schedule', () => {
		const result = formatTrigger({
			name: 'Daily check',
			type: 'cron',
			config: { expression: '0 9 * * *' },
			enabled: true,
		})
		expect(result).toContain('Daily check')
		expect(result).toContain('✓ enabled')
		expect(result).toContain('daily at 09:00')
		expect(result).toContain('0 9 * * *')
	})

	it('shows event trigger filters', () => {
		const result = formatTrigger({
			name: 'On bet create',
			type: 'event',
			config: {
				entity_type: 'object',
				action: 'created',
				filter: { type: 'bet', status: 'signal' },
			},
			enabled: true,
		})
		expect(result).toContain('Fires on: object created')
		expect(result).toContain('Filter: type = bet, status = signal')
	})

	it('formats disabled trigger', () => {
		const result = formatTrigger({ name: 'Off', enabled: false })
		expect(result).toContain('✗ disabled')
	})
})

describe('formatTriggerList', () => {
	it('shows empty state with guidance', () => {
		const result = formatTriggerList([])
		expect(result).toContain('No triggers configured')
		expect(result).toContain('create_trigger')
	})

	it('shows human-readable cron schedule', () => {
		const result = formatTriggerList([
			{
				id: 'trig-1',
				name: 'Daily check',
				type: 'cron',
				config: { expression: '*/5 * * * *' },
				enabled: true,
				target_actor_id: 'actor-1',
				action_prompt: 'Check all bets',
			},
		])
		expect(result).toContain('cron (every 5 min)')
		expect(result).toContain('ID: trig-1')
		expect(result).toContain('Target: actor-1')
		expect(result).toContain('Prompt: "Check all bets"')
	})

	it('shows event trigger details', () => {
		const result = formatTriggerList([
			{
				id: 'trig-2',
				name: 'On create',
				type: 'event',
				config: { entity_type: 'object', action: 'created' },
				enabled: true,
			},
		])
		expect(result).toContain('event (object created)')
	})
})

describe('formatNotification', () => {
	it('uses correct icon per type', () => {
		expect(formatNotification({ type: 'needs_input', title: 'Q' })).toContain('❓')
		expect(formatNotification({ type: 'recommendation', title: 'R' })).toContain('💡')
		expect(formatNotification({ type: 'good_news', title: 'G' })).toContain('🎉')
		expect(formatNotification({ type: 'alert', title: 'A' })).toContain('🚨')
	})

	it('shows metadata actions and question', () => {
		const result = formatNotification({
			type: 'needs_input',
			title: 'Approval needed',
			metadata: {
				actions: [{ label: 'Approve' }, { label: 'Reject' }],
				question: 'Should we proceed?',
				urgency_label: 'high',
				input_type: 'confirmation',
			},
		})
		expect(result).toContain('Actions: Approve, Reject')
		expect(result).toContain('Question: "Should we proceed?"')
		expect(result).toContain('Urgency: high')
		expect(result).toContain('Input: confirmation')
	})
})

describe('formatNotificationList', () => {
	it('shows empty state with guidance', () => {
		const result = formatNotificationList([])
		expect(result).toContain('No notifications')
		expect(result).toContain('create_notification')
	})

	it('shows notification IDs and content preview', () => {
		const result = formatNotificationList([
			{
				id: 'notif-1',
				type: 'needs_input',
				title: 'Need approval',
				status: 'pending',
				content: 'Should we proceed with the proposed strategy?',
			},
		])
		expect(result).toContain('ID: notif-1')
		expect(result).toContain('Should we proceed')
	})
})

describe('formatWorkspace', () => {
	it('formats workspace details', () => {
		const result = formatWorkspace({
			name: 'My WS',
			id: 'ws-1',
			settings: { statuses: { bet: ['active'], task: ['todo'] } },
		})
		expect(result).toContain('🏢 My WS')
		expect(result).toContain('ws-1')
		expect(result).toContain('bet, task')
	})

	it('shows custom fields and relationship types', () => {
		const result = formatWorkspace({
			name: 'WS',
			id: 'ws-1',
			settings: {
				statuses: { bet: ['active'], task: ['todo'] },
				field_definitions: {
					bet: [{ name: 'priority' }],
					task: [{ name: 'effort' }, { name: 'due' }],
				},
				relationship_types: ['informs', 'blocks'],
			},
		})
		expect(result).toContain('Custom fields: 3 across 2 types')
		expect(result).toContain('Relationship types: informs, blocks')
	})
})

describe('formatWorkspaceList', () => {
	it('shows empty state', () => {
		expect(formatWorkspaceList([])).toContain('No workspaces found')
	})
})

describe('formatRelationshipList', () => {
	it('shows empty state with guidance', () => {
		const result = formatRelationshipList([])
		expect(result).toContain('No relationships found')
		expect(result).toContain('create_objects')
	})

	it('formats relationships with full IDs and tip', () => {
		const result = formatRelationshipList([
			{
				id: 'rel-1',
				type: 'informs',
				source_id: 'abcdefgh-1234-5678-9012-345678901234',
				target_id: 'ijklmnop-5678-1234-9012-345678901234',
			},
		])
		expect(result).toContain('Relationships (1)')
		expect(result).toContain('informs')
		expect(result).toContain('[rel-1]')
		expect(result).toContain('abcdefgh-1234-5678-9012-345678901234')
		expect(result).toContain('ijklmnop-5678-1234-9012-345678901234')
		expect(result).toContain('Tip: Use get_objects')
	})
})

describe('formatIntegrationList', () => {
	it('shows empty state', () => {
		expect(formatIntegrationList([])).toContain('No integrations connected')
	})
})

describe('formatProviderList', () => {
	it('shows empty state', () => {
		expect(formatProviderList([])).toContain('No integration providers')
	})

	it('formats providers', () => {
		const result = formatProviderList([
			{ name: 'github', display_name: 'GitHub', auth: { type: 'oauth2' }, events: [{}, {}] },
		])
		expect(result).toContain('GitHub')
		expect(result).toContain('oauth2')
		expect(result).toContain('2 events')
	})
})

describe('formatExtension', () => {
	it('formats extension with types and field names', () => {
		const result = formatExtension({
			id: 'work',
			name: 'Work',
			enabled: true,
			types: [
				{
					type: 'task',
					display_name: 'Task',
					statuses: ['todo', 'done'],
					fields: [{ name: 'priority', type: 'enum' }],
				},
			],
		})
		expect(result).toContain('🧩 Work')
		expect(result).toContain('✓ enabled')
		expect(result).toContain('Task (task)')
		expect(result).toContain('todo → done')
		expect(result).toContain('[fields: priority]')
	})

	it('shows extension ID', () => {
		const result = formatExtension({ id: 'my_ext', name: 'My Extension', enabled: true })
		expect(result).toContain('ID: my_ext')
	})
})

describe('formatExtensionList', () => {
	it('shows empty state with guidance', () => {
		const result = formatExtensionList([])
		expect(result).toContain('No extensions found')
		expect(result).toContain('create_extension')
	})

	it('shows type details under each extension', () => {
		const result = formatExtensionList([
			{
				id: 'work',
				name: 'Work',
				enabled: true,
				types: [
					{ type: 'task', display_name: 'Task', statuses: ['todo', 'done'] },
					{
						type: 'bet',
						display_name: 'Bet',
						statuses: ['active', 'completed'],
						fields: [{ name: 'priority' }, { name: 'effort' }],
					},
				],
			},
		])
		expect(result).toContain('✓ Work (work)')
		expect(result).toContain('Task (task): todo → done')
		expect(result).toContain('Bet (bet): active → completed')
		expect(result).toContain('[2 fields]')
	})

	it('shows disabled extensions', () => {
		const result = formatExtensionList([{ id: 'crm', name: 'CRM', enabled: false, types: [] }])
		expect(result).toContain('✗ CRM (crm) — disabled')
	})
})

describe('formatSchema', () => {
	it('formats workspace schema with summary and arrow statuses', () => {
		const result = formatSchema({
			types: {
				bet: {
					display_name: 'Bet',
					statuses: ['active', 'proposed'],
					fields: [{ name: 'priority', type: 'enum', required: true, values: ['low', 'high'] }],
				},
			},
			relationship_types: ['informs', 'blocks'],
		})
		expect(result).toContain('📐 Workspace Schema — 1 type, 2 relationship types')
		expect(result).toContain('Bet (bet)')
		expect(result).toContain('active → proposed')
		expect(result).toContain('priority: enum (required) [low, high]')
		expect(result).toContain('informs, blocks')
	})

	it('shows enum values inline', () => {
		const result = formatSchema({
			types: {
				task: {
					display_name: 'Task',
					statuses: ['todo'],
					fields: [
						{ name: 'size', type: 'enum', required: false, values: ['S', 'M', 'L'] },
						{ name: 'due', type: 'date', required: false },
					],
				},
			},
		})
		expect(result).toContain('size: enum [S, M, L]')
		expect(result).toContain('due: date')
	})
})

describe('formatConfirmation', () => {
	it('formats with detail', () => {
		expect(formatConfirmation('Deleted', 'object abc')).toBe('✅ Deleted: object abc')
	})

	it('formats without detail', () => {
		expect(formatConfirmation('Done')).toBe('✅ Done')
	})

	it('formats with hint', () => {
		expect(formatConfirmation('Created', '3 objects', 'Use get_objects to view.')).toBe(
			'✅ Created: 3 objects\nUse get_objects to view.',
		)
	})

	it('ignores undefined hint', () => {
		expect(formatConfirmation('Created', '1 object', undefined)).toBe('✅ Created: 1 object')
	})
})

describe('formatDashboard', () => {
	it('formats a full dashboard with totals', () => {
		const result = formatDashboard({
			workspace: { name: 'My WS' },
			objects: [
				{ type: 'bet', status: 'active' },
				{ type: 'bet', status: 'active' },
				{ type: 'task', status: 'todo' },
			],
			events: [
				{ action: 'created', actor_name: 'Alice', entity_type: 'object', metadata: { title: 'X' } },
			],
			sessions: [{ id: 'sess-1', status: 'running', actor_name: 'Bot', action_prompt: 'Fix bug' }],
			members: [{ name: 'Alice', type: 'human', role: 'owner' }],
		})
		expect(result).toContain('📊 Workspace Dashboard — "My WS"')
		expect(result).toContain('Objects by Type (3 total)')
		expect(result).toContain('bet: 2 active (2 total)')
		expect(result).toContain('task: 1 todo (1 total)')
		expect(result).toContain('Alice')
		expect(result).toContain('Active Sessions')
		expect(result).toContain('Bot')
		expect(result).toContain('Team (1 member)')
	})

	it('handles empty workspace with guidance', () => {
		const result = formatDashboard({})
		expect(result).toContain('Workspace Dashboard')
		expect(result).toContain('No objects yet')
		expect(result).toContain('create_objects')
	})
})
