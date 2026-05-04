import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import {
	actors,
	notifications,
	objects,
	relationships,
	sessionLogs,
	sessions,
	triggers,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'

let counter = 0
function next() {
	return ++counter
}

// ── DB Row Builders (for mockResults) ───────────────────────────────────────

export function buildActor(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		type: 'human' as const,
		name: `Actor ${n}`,
		email: `actor-${n}@test.com`,
		apiKey: `ank_test${n}`,
		systemPrompt: null,
		tools: null,
		memory: null,
		llmProvider: null,
		llmConfig: null,
		isSystem: false,
		createdBy: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildWorkspace(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		name: `Workspace ${n}`,
		settings: {
			enabled_modules: ['work'],
			display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
			statuses: {
				insight: ['new', 'processing', 'clustered', 'discarded'],
				bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
				task: ['todo', 'in_progress', 'done', 'blocked'],
			},
			field_definitions: {},
			relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
		},
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildObject(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		type: 'task' as const,
		title: `Object ${n}`,
		content: `Content for object ${n}`,
		status: 'todo',
		metadata: null,
		owner: null,
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildRelationship(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		sourceType: 'insight',
		sourceId: randomUUID(),
		targetType: 'bet',
		targetId: randomUUID(),
		type: 'informs',
		createdBy: randomUUID(),
		createdAt: new Date(),
		...overrides,
	}
}

export function buildEvent(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: n,
		workspaceId: randomUUID(),
		actorId: randomUUID(),
		action: 'created',
		entityType: 'task',
		entityId: randomUUID(),
		data: null,
		createdAt: new Date(),
		...overrides,
	}
}

export function buildTrigger(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		name: `Trigger ${n}`,
		type: 'event' as const,
		config: { entity_type: 'task', action: 'created' },
		actionPrompt: `Handle trigger ${n}`,
		targetActorId: randomUUID(),
		enabled: true,
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildWorkspaceMember(overrides?: Record<string, unknown>) {
	return {
		workspaceId: randomUUID(),
		actorId: randomUUID(),
		role: 'member',
		joinedAt: new Date(),
		...overrides,
	}
}

// ── API Request Body Builders ───────────────────────────────────────────────

export function buildCreateActorBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		type: 'human',
		name: `Actor ${n}`,
		email: `actor-${n}@test.com`,
		password: 'testpassword123',
		...overrides,
	}
}

export function buildCreateObjectBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		type: 'task',
		title: `Task ${n}`,
		content: `Content ${n}`,
		status: 'todo',
		...overrides,
	}
}

export function buildUpdateObjectBody(overrides?: Record<string, unknown>) {
	return {
		title: 'Updated title',
		...overrides,
	}
}

export function buildCreateWorkspaceBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		name: `Workspace ${n}`,
		...overrides,
	}
}

export function buildCreateRelationshipBody(overrides?: Record<string, unknown>) {
	return {
		source_type: 'insight',
		source_id: randomUUID(),
		target_type: 'bet',
		target_id: randomUUID(),
		type: 'informs',
		...overrides,
	}
}

export function buildCreateTriggerBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		name: `Trigger ${n}`,
		type: 'event',
		config: { entity_type: 'task', action: 'created' },
		action_prompt: `Handle trigger ${n}`,
		target_actor_id: randomUUID(),
		...overrides,
	}
}

export function buildSession(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		actorId: randomUUID(),
		triggerId: null,
		status: 'running',
		containerId: `container-${n}`,
		actionPrompt: `Do something ${n}`,
		config: {},
		interactive: false,
		result: null,
		snapshotPath: null,
		startedAt: new Date(),
		completedAt: null,
		timeoutAt: null,
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildSessionLog(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: n,
		sessionId: randomUUID(),
		stream: 'stdout',
		content: `Log line ${n}`,
		createdAt: new Date(),
		...overrides,
	}
}

export function buildNotification(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		type: 'needs_input' as const,
		title: `Notification ${n}`,
		content: `Content for notification ${n}`,
		metadata: null,
		sourceActorId: randomUUID(),
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildIntegration(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		provider: 'github',
		status: 'active',
		externalId: `ext-${n}`,
		credentials: `encrypted-creds-${n}`,
		config: {},
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildCreateSessionBody(overrides?: Record<string, unknown>) {
	return {
		actor_id: randomUUID(),
		action_prompt: 'Run tests and fix issues',
		auto_start: true,
		...overrides,
	}
}

export function buildCreateNotificationBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		type: 'needs_input',
		title: `Notification ${n}`,
		content: `Content ${n}`,
		source_actor_id: randomUUID(),
		...overrides,
	}
}

export function buildAgentSkill(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		path: `skills/my-skill-${n}/SKILL.md`,
		sizeBytes: 256,
		updatedAt: new Date(),
		actorId: randomUUID(),
		workspaceId: randomUUID(),
		fileType: 'skills',
		...overrides,
	}
}

export function buildWorkspaceSkill(overrides?: Record<string, unknown>) {
	const n = next()
	const name = `ws-skill-${n}`
	const workspaceId = randomUUID()
	const id = randomUUID()
	return {
		id,
		workspaceId,
		name,
		description: `Workspace skill ${n}`,
		content: `---\nname: ${name}\ndescription: Workspace skill ${n}\n---\n\nDo the thing ${n}`,
		storageKey: `workspaces/${workspaceId}/skills/${id}/SKILL.md`,
		sizeBytes: 128,
		isValid: true,
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildCreateWorkspaceSkillBody(overrides?: Record<string, unknown>) {
	const n = next()
	const name = `ws-skill-${n}`
	return {
		name,
		content: `---\nname: ${name}\ndescription: Workspace skill ${n}\n---\n\nDo the thing ${n}`,
		...overrides,
	}
}

export function buildUpdateWorkspaceSkillBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		content: `---\nname: skill\ndescription: Updated skill ${n}\n---\n\nNew body ${n}`,
		...overrides,
	}
}

export function buildSaveSkillBody(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		description: `A test skill ${n}`,
		content: `Do the thing ${n}`,
		...overrides,
	}
}

export function buildImport(overrides?: Record<string, unknown>) {
	const n = next()
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		status: 'mapping',
		fileName: `import-${n}.csv`,
		fileType: 'csv',
		fileStorageKey: `imports/ws/${randomUUID()}/import-${n}.csv`,
		totalRows: 10,
		processedRows: 0,
		successCount: 0,
		errorCount: 0,
		mapping: {
			typeMappings: [
				{
					objectType: 'task',
					columns: [{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false }],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		},
		preview: {
			columns: ['name'],
			sampleRows: [{ name: 'Test' }],
			totalRows: 10,
		},
		errors: null,
		source: 'file',
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		completedAt: null,
		...overrides,
	}
}

export function buildCreateGraphBody(overrides?: Record<string, unknown>) {
	return {
		nodes: [
			{ $id: 'bet-1', type: 'bet', title: 'Improve onboarding', status: 'active' },
			{ $id: 'task-1', type: 'task', title: 'Add welcome wizard', status: 'todo' },
		],
		edges: [{ source: 'bet-1', target: 'task-1', type: 'breaks_into' }],
		...overrides,
	}
}

// ── Real DB Inserters (for integration tests) ──────────────────────────────

export async function insertActor(db: Database, overrides?: Record<string, unknown>) {
	const data = buildActor(overrides)
	const rows = await db.insert(actors).values(data).returning()
	return rows[0]
}

export async function insertWorkspace(
	db: Database,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildWorkspace({ createdBy: actorId, ...overrides })
	const rows = await db.insert(workspaces).values(data).returning()
	const ws = rows[0]
	await db.insert(workspaceMembers).values({
		workspaceId: ws.id,
		actorId,
		role: 'owner',
	})
	return ws
}

export async function insertObject(
	db: Database,
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildObject({ workspaceId, createdBy: actorId, ...overrides })
	const rows = await db.insert(objects).values(data).returning()
	return rows[0]
}

export async function insertRelationship(
	db: Database,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildRelationship({ createdBy: actorId, ...overrides })
	const rows = await db.insert(relationships).values(data).returning()
	return rows[0]
}

export async function insertNotification(
	db: Database,
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildNotification({
		workspaceId,
		sourceActorId: actorId,
		...overrides,
	})
	const rows = await db.insert(notifications).values(data).returning()
	return rows[0]
}

export async function insertSession(
	db: Database,
	workspaceId: string,
	actorId: string,
	createdBy: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildSession({ workspaceId, actorId, createdBy, ...overrides })
	const rows = await db.insert(sessions).values(data).returning()
	return rows[0]
}

export async function insertSessionLog(
	db: Database,
	sessionId: string,
	overrides?: Record<string, unknown>,
) {
	const { id: _id, ...data } = buildSessionLog({ sessionId, ...overrides })
	const rows = await db.insert(sessionLogs).values(data).returning()
	return rows[0]
}

export async function insertTrigger(
	db: Database,
	workspaceId: string,
	actorId: string,
	targetActorId: string,
	overrides?: Record<string, unknown>,
) {
	const data = buildTrigger({
		workspaceId,
		createdBy: actorId,
		targetActorId,
		...overrides,
	})
	const rows = await db.insert(triggers).values(data).returning()
	return rows[0]
}
