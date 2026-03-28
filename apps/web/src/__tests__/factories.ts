import type { ActorWithKey, ObjectResponse } from '@/lib/api'

let counter = 0
function nextId(prefix: string) {
	return `${prefix}-${++counter}`
}

export function buildObjectResponse(
	overrides: Partial<ObjectResponse> = {},
): ObjectResponse {
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

export function buildActorWithKey(
	overrides: Partial<ActorWithKey> = {},
): ActorWithKey {
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
