import knowledgeExtension from '@maskin/ext-knowledge/server'
import workExtension from '@maskin/ext-work/server'
import { describe, expect, it } from 'vitest'

describe('knowledge extension server definition', () => {
	it('declares a knowledge object type with the expected shape', () => {
		expect(knowledgeExtension.id).toBe('knowledge')
		expect(knowledgeExtension.objectTypes).toHaveLength(1)
		const type = knowledgeExtension.objectTypes[0]
		expect(type?.type).toBe('knowledge')
		expect(type?.defaultStatuses).toEqual(['draft', 'validated', 'deprecated'])
		expect(type?.defaultRelationshipTypes).toEqual(['supersedes', 'contradicts', 'about'])
		const fieldNames = type?.defaultFields?.map((f) => f.name)
		expect(fieldNames).toEqual(['summary', 'confidence', 'tags', 'last_validated_at'])
	})

	it('contributes matching default settings for the knowledge type', () => {
		const settings = knowledgeExtension.defaultSettings
		expect(settings?.statuses?.knowledge).toEqual(['draft', 'validated', 'deprecated'])
		expect(settings?.display_names?.knowledge).toBe('Article')
		expect(settings?.relationship_types).toEqual(['supersedes', 'contradicts', 'about'])
		expect(settings?.field_definitions?.knowledge?.map((f) => f.name)).toEqual([
			'summary',
			'confidence',
			'tags',
			'last_validated_at',
		])
	})

	it('uses a module id distinct from the work extension', () => {
		expect(knowledgeExtension.id).not.toBe(workExtension.id)
	})

	it('ships a Knowledge Curator seed agent', () => {
		const curator = knowledgeExtension.seedAgents?.find((a) => a.$id === 'knowledge_curator')
		expect(curator).toBeDefined()
		expect(curator?.name).toBe('Knowledge Curator')
		expect(curator?.systemPrompt).toContain('{{self_id}}')
		expect(curator?.systemPrompt).toContain('session_completed')
	})

	it('ships a session-completed trigger and a weekly lint cron targeting the curator', () => {
		const triggers = knowledgeExtension.seedTriggers ?? []
		const ingest = triggers.find((t) => t.type === 'event')
		const lint = triggers.find((t) => t.type === 'cron')
		expect(ingest).toBeDefined()
		expect(ingest?.config).toMatchObject({
			entity_type: 'session',
			action: 'session_completed',
		})
		expect(ingest?.targetActor$id).toBe('knowledge_curator')
		expect(lint).toBeDefined()
		expect((lint?.config as { expression?: string }).expression).toBeTruthy()
		expect(lint?.targetActor$id).toBe('knowledge_curator')
	})

	it('the session-completed trigger prompt guards against self-recursion', () => {
		const ingest = knowledgeExtension.seedTriggers?.find((t) => t.type === 'event')
		expect(ingest?.actionPrompt).toMatch(/actor_id/i)
		expect(ingest?.actionPrompt).toMatch(/\{\{self_id\}\}/)
	})
})
