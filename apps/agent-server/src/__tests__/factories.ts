import { randomUUID } from 'node:crypto'

export function buildSession(overrides?: Record<string, unknown>) {
	const n = Math.floor(Math.random() * 10000)
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		actorId: randomUUID(),
		triggerId: null,
		status: 'running',
		containerId: `container-${n}`,
		actionPrompt: `Do something ${n}`,
		config: {},
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
	const n = Math.floor(Math.random() * 10000)
	return {
		id: n,
		sessionId: randomUUID(),
		stream: 'stdout',
		content: `Log line ${n}`,
		createdAt: new Date(),
		...overrides,
	}
}

export function buildActor(overrides?: Record<string, unknown>) {
	const n = Math.floor(Math.random() * 10000)
	return {
		id: randomUUID(),
		type: 'agent' as const,
		name: `Agent ${n}`,
		email: null,
		apiKey: `ank_test${n}`,
		systemPrompt: 'You are a helpful agent.',
		tools: null,
		memory: null,
		llmProvider: 'anthropic',
		llmConfig: {},
		createdBy: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

export function buildWorkspace(overrides?: Record<string, unknown>) {
	const n = Math.floor(Math.random() * 10000)
	return {
		id: randomUUID(),
		name: `Workspace ${n}`,
		settings: { max_concurrent_sessions: 3 },
		createdBy: randomUUID(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}
