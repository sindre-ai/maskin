import { describe, expect, it } from 'vitest'
import {
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
	it('shows empty state', () => {
		expect(formatObjectList([])).toContain('No objects found')
	})

	it('shows search query in empty state', () => {
		expect(formatObjectList([], { query: 'test' })).toContain('No objects found matching "test"')
	})

	it('formats list of objects', () => {
		const result = formatObjectList([
			{ type: 'bet', status: 'active', title: 'Bet 1' },
			{ type: 'task', status: 'todo', title: 'Task 1' },
		])
		expect(result).toContain('📋 Objects (2 results)')
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
})

describe('formatActorList', () => {
	it('shows empty state', () => {
		expect(formatActorList([])).toContain('No team members')
	})

	it('formats team list', () => {
		const result = formatActorList([
			{ name: 'Alice', type: 'human', role: 'owner' },
			{ name: 'Bot', type: 'agent', role: 'member' },
		])
		expect(result).toContain('Team (2 members)')
		expect(result).toContain('Alice — human (owner)')
		expect(result).toContain('Bot — agent (member)')
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
	it('shows empty state', () => {
		expect(formatSessionList([])).toContain('No sessions found')
	})
})

describe('formatTrigger', () => {
	it('formats cron trigger', () => {
		const result = formatTrigger({
			name: 'Daily check',
			type: 'cron',
			config: { expression: '0 9 * * *' },
			enabled: true,
		})
		expect(result).toContain('Daily check')
		expect(result).toContain('✓ enabled')
		expect(result).toContain('0 9 * * *')
	})

	it('formats disabled trigger', () => {
		const result = formatTrigger({ name: 'Off', enabled: false })
		expect(result).toContain('✗ disabled')
	})
})

describe('formatTriggerList', () => {
	it('shows empty state', () => {
		expect(formatTriggerList([])).toContain('No triggers configured')
	})
})

describe('formatNotification', () => {
	it('uses correct icon per type', () => {
		expect(formatNotification({ type: 'needs_input', title: 'Q' })).toContain('❓')
		expect(formatNotification({ type: 'recommendation', title: 'R' })).toContain('💡')
		expect(formatNotification({ type: 'good_news', title: 'G' })).toContain('🎉')
		expect(formatNotification({ type: 'alert', title: 'A' })).toContain('🚨')
	})
})

describe('formatNotificationList', () => {
	it('shows empty state', () => {
		expect(formatNotificationList([])).toContain('No notifications')
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
})

describe('formatWorkspaceList', () => {
	it('shows empty state', () => {
		expect(formatWorkspaceList([])).toContain('No workspaces found')
	})
})

describe('formatRelationshipList', () => {
	it('shows empty state', () => {
		expect(formatRelationshipList([])).toContain('No relationships found')
	})

	it('formats relationships', () => {
		const result = formatRelationshipList([
			{ type: 'informs', source_id: 'abcdefgh-1234', target_id: 'ijklmnop-5678' },
		])
		expect(result).toContain('Relationships (1)')
		expect(result).toContain('informs')
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
	it('formats extension with types', () => {
		const result = formatExtension({
			id: 'work',
			name: 'Work',
			enabled: true,
			types: [{ type: 'task', display_name: 'Task', statuses: ['todo', 'done'] }],
		})
		expect(result).toContain('🧩 Work')
		expect(result).toContain('✓ enabled')
		expect(result).toContain('Task')
		expect(result).toContain('todo, done')
	})
})

describe('formatExtensionList', () => {
	it('shows empty state', () => {
		expect(formatExtensionList([])).toContain('No extensions found')
	})
})

describe('formatSchema', () => {
	it('formats workspace schema', () => {
		const result = formatSchema({
			types: {
				bet: {
					display_name: 'Bet',
					statuses: ['active', 'proposed'],
					fields: [{ name: 'priority', type: 'enum', required: true }],
				},
			},
			relationship_types: ['informs', 'blocks'],
		})
		expect(result).toContain('📐 Workspace Schema')
		expect(result).toContain('Bet (bet)')
		expect(result).toContain('active, proposed')
		expect(result).toContain('priority: enum (required)')
		expect(result).toContain('informs, blocks')
	})
})

describe('formatConfirmation', () => {
	it('formats with detail', () => {
		expect(formatConfirmation('Deleted', 'object abc')).toBe('✅ Deleted: object abc')
	})

	it('formats without detail', () => {
		expect(formatConfirmation('Done')).toBe('✅ Done')
	})
})

describe('formatDashboard', () => {
	it('formats a full dashboard', () => {
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
			sessions: [{ status: 'running', actor_name: 'Bot', action_prompt: 'Fix bug' }],
			members: [{ name: 'Alice', type: 'human', role: 'owner' }],
		})
		expect(result).toContain('📊 Workspace Dashboard — "My WS"')
		expect(result).toContain('bet: 2 active')
		expect(result).toContain('task: 1 todo')
		expect(result).toContain('Alice')
		expect(result).toContain('Active Sessions')
		expect(result).toContain('Bot')
		expect(result).toContain('Team (1 member)')
	})

	it('handles empty workspace', () => {
		const result = formatDashboard({})
		expect(result).toContain('Workspace Dashboard')
		expect(result).toContain('No objects yet')
	})
})
