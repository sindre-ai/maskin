import { queryKeys } from '@/lib/query-keys'
import { describe, expect, it } from 'vitest'

describe('queryKeys', () => {
	describe('objects', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.objects.all('ws-1')).toEqual(['objects', 'ws-1'])
		})

		it('list includes workspaceId and filters', () => {
			const filters = { type: 'task' }
			expect(queryKeys.objects.list('ws-1', filters)).toEqual(['objects', 'ws-1', 'list', filters])
		})

		it('list without filters includes undefined', () => {
			expect(queryKeys.objects.list('ws-1')).toEqual(['objects', 'ws-1', 'list', undefined])
		})

		it('detail includes id', () => {
			expect(queryKeys.objects.detail('obj-1')).toEqual(['objects', 'detail', 'obj-1'])
		})
	})

	describe('bets', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.bets.all('ws-1')).toEqual(['bets', 'ws-1'])
		})
	})

	describe('actors', () => {
		it('all includes optional workspaceId', () => {
			expect(queryKeys.actors.all('ws-1')).toEqual(['actors', 'ws-1'])
			expect(queryKeys.actors.all()).toEqual(['actors', undefined])
		})

		it('detail includes id', () => {
			expect(queryKeys.actors.detail('a-1')).toEqual(['actors', 'detail', 'a-1'])
		})
	})

	describe('workspaces', () => {
		it('all returns static key', () => {
			expect(queryKeys.workspaces.all()).toEqual(['workspaces'])
		})

		it('detail includes id', () => {
			expect(queryKeys.workspaces.detail('ws-1')).toEqual(['workspaces', 'detail', 'ws-1'])
		})

		it('members includes workspaceId', () => {
			expect(queryKeys.workspaces.members('ws-1')).toEqual(['workspaces', 'ws-1', 'members'])
		})
	})

	describe('relationships', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.relationships.all('ws-1')).toEqual(['relationships', 'ws-1'])
		})
	})

	describe('sessions', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.sessions.all('ws-1')).toEqual(['sessions', 'ws-1'])
		})

		it('detail includes id', () => {
			expect(queryKeys.sessions.detail('s-1')).toEqual(['sessions', 'detail', 's-1'])
		})

		it('logs includes sessionId', () => {
			expect(queryKeys.sessions.logs('s-1')).toEqual(['sessions', 's-1', 'logs'])
		})

		it('byActor includes workspaceId and actorId', () => {
			expect(queryKeys.sessions.byActor('ws-1', 'a-1')).toEqual([
				'sessions',
				'ws-1',
				'actor',
				'a-1',
				'running',
			])
		})

		it('byActorAll includes workspaceId and actorId', () => {
			expect(queryKeys.sessions.byActorAll('ws-1', 'a-1')).toEqual([
				'sessions',
				'ws-1',
				'actor',
				'a-1',
				'all',
			])
		})
	})

	describe('triggers', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.triggers.all('ws-1')).toEqual(['triggers', 'ws-1'])
		})

		it('detail includes id', () => {
			expect(queryKeys.triggers.detail('t-1')).toEqual(['triggers', 'detail', 't-1'])
		})
	})

	describe('integrations', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.integrations.all('ws-1')).toEqual(['integrations', 'ws-1'])
		})

		it('providers returns static key', () => {
			expect(queryKeys.integrations.providers()).toEqual(['integrations', 'providers'])
		})
	})

	describe('skills', () => {
		it('all includes actorId', () => {
			expect(queryKeys.skills.all('a-1')).toEqual(['skills', 'a-1'])
		})

		it('detail includes actorId and skillName', () => {
			expect(queryKeys.skills.detail('a-1', 'code-review')).toEqual([
				'skills',
				'a-1',
				'code-review',
			])
		})
	})

	describe('workspaceSkills', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.workspaceSkills.all('ws-1')).toEqual(['workspace-skills', 'ws-1'])
		})

		it('detail includes workspaceId and name', () => {
			expect(queryKeys.workspaceSkills.detail('ws-1', 'my-skill')).toEqual([
				'workspace-skills',
				'ws-1',
				'my-skill',
			])
		})
	})

	describe('agentSkillAttachments', () => {
		it('all includes actorId', () => {
			expect(queryKeys.agentSkillAttachments.all('a-1')).toEqual(['agent-skill-attachments', 'a-1'])
		})
	})

	describe('notifications', () => {
		it('all includes workspaceId', () => {
			expect(queryKeys.notifications.all('ws-1')).toEqual(['notifications', 'ws-1'])
		})

		it('list includes workspaceId and filters', () => {
			expect(queryKeys.notifications.list('ws-1', { status: 'pending' })).toEqual([
				'notifications',
				'ws-1',
				'list',
				{ status: 'pending' },
			])
		})

		it('detail includes id', () => {
			expect(queryKeys.notifications.detail('n-1')).toEqual(['notifications', 'detail', 'n-1'])
		})
	})

	describe('events', () => {
		it('history includes workspaceId', () => {
			expect(queryKeys.events.history('ws-1')).toEqual(['events', 'ws-1', 'history', undefined])
		})

		it('byEntity includes entityId', () => {
			expect(queryKeys.events.byEntity('e-1')).toEqual(['events', 'entity', 'e-1'])
		})
	})

	describe('claudeOauth', () => {
		it('status includes workspaceId', () => {
			expect(queryKeys.claudeOauth.status('ws-1')).toEqual(['claude-oauth', 'ws-1', 'status'])
		})
	})
})
