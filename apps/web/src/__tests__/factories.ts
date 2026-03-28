import type {
	ActorListItem,
	ActorResponse,
	ActorWithKey,
	EventResponse,
	IntegrationResponse,
	NotificationResponse,
	ObjectResponse,
	RelationshipResponse,
	SessionResponse,
	SkillListItem,
	TriggerResponse,
	WorkspaceWithRole,
} from '@/lib/api'

let counter = 0
function nextId(prefix: string) {
	return `${prefix}-${++counter}`
}

export function buildObjectResponse(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	const id = overrides.id ?? nextId('obj')
	return {
		id,
		workspaceId: 'ws-1',
		type: 'bet',
		title: 'Test Object',
		content: null,
		status: 'active',
		metadata: null,
		owner: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildActorWithKey(overrides: Partial<ActorWithKey> = {}): ActorWithKey {
	const id = overrides.id ?? nextId('actor')
	return {
		id,
		name: 'Test User',
		type: 'human',
		email: 'test@example.com',
		api_key: 'ank_test123',
		systemPrompt: null,
		tools: null,
		memory: null,
		llmProvider: null,
		llmConfig: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildActorResponse(overrides: Partial<ActorResponse> = {}): ActorResponse {
	const id = overrides.id ?? nextId('actor')
	return {
		id,
		name: 'Test User',
		type: 'human',
		email: 'test@example.com',
		systemPrompt: null,
		tools: null,
		memory: null,
		llmProvider: null,
		llmConfig: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildActorListItem(overrides: Partial<ActorListItem> = {}): ActorListItem {
	const id = overrides.id ?? nextId('actor')
	return {
		id,
		name: 'Test User',
		type: 'human',
		email: 'test@example.com',
		...overrides,
	}
}

export function buildEventResponse(overrides: Partial<EventResponse> = {}): EventResponse {
	return {
		id: overrides.id ?? ++counter,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		action: 'created',
		entityType: 'bet',
		entityId: 'obj-1',
		data: null,
		createdAt: '2026-01-01T00:00:00Z',
		...overrides,
	}
}

export function buildRelationshipResponse(
	overrides: Partial<RelationshipResponse> = {},
): RelationshipResponse {
	const id = overrides.id ?? nextId('rel')
	return {
		id,
		sourceType: 'insight',
		sourceId: 'obj-1',
		targetType: 'bet',
		targetId: 'obj-2',
		type: 'informs',
		createdBy: 'actor-1',
		createdAt: null,
		...overrides,
	}
}

export function buildWorkspaceWithRole(
	overrides: Partial<WorkspaceWithRole> = {},
): WorkspaceWithRole {
	const id = overrides.id ?? nextId('ws')
	return {
		id,
		name: 'Test Workspace',
		settings: {},
		role: 'admin',
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildSessionResponse(overrides: Partial<SessionResponse> = {}): SessionResponse {
	const id = overrides.id ?? nextId('session')
	return {
		id,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Do something',
		config: null,
		result: null,
		snapshotPath: null,
		startedAt: '2026-01-01T00:00:00Z',
		completedAt: null,
		timeoutAt: null,
		createdBy: 'actor-1',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: null,
		...overrides,
	}
}

export function buildNotificationResponse(
	overrides: Partial<NotificationResponse> = {},
): NotificationResponse {
	const id = overrides.id ?? nextId('notif')
	return {
		id,
		workspaceId: 'ws-1',
		type: 'needs_input',
		title: 'Test Notification',
		content: null,
		metadata: null,
		sourceActorId: 'actor-1',
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: null,
		...overrides,
	}
}

export function buildTriggerResponse(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	const id = overrides.id ?? nextId('trigger')
	return {
		id,
		workspaceId: 'ws-1',
		name: 'Test Trigger',
		type: 'cron',
		config: { schedule: '0 * * * *' },
		actionPrompt: 'Run something',
		targetActorId: 'actor-1',
		enabled: true,
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildIntegrationResponse(
	overrides: Partial<IntegrationResponse> = {},
): IntegrationResponse {
	const id = overrides.id ?? nextId('integration')
	return {
		id,
		workspaceId: 'ws-1',
		provider: 'slack',
		status: 'active',
		externalId: null,
		config: {},
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

export function buildSkillListItem(overrides: Partial<SkillListItem> = {}): SkillListItem {
	return {
		name: 'test-skill',
		description: 'A test skill',
		size_bytes: 1024,
		updated_at: '2026-01-01T00:00:00Z',
		...overrides,
	}
}
