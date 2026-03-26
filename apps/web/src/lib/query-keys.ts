export const queryKeys = {
	objects: {
		all: (workspaceId: string) => ['objects', workspaceId] as const,
		list: (workspaceId: string, filters?: Record<string, unknown>) =>
			['objects', workspaceId, 'list', filters] as const,
		detail: (id: string) => ['objects', 'detail', id] as const,
	},
	bets: {
		all: (workspaceId: string) => ['bets', workspaceId] as const,
	},
	actors: {
		all: (workspaceId?: string) => ['actors', workspaceId] as const,
		detail: (id: string) => ['actors', 'detail', id] as const,
	},
	workspaces: {
		all: () => ['workspaces'] as const,
		detail: (id: string) => ['workspaces', 'detail', id] as const,
		members: (id: string) => ['workspaces', id, 'members'] as const,
	},
	relationships: {
		all: (workspaceId: string) => ['relationships', workspaceId] as const,
		byObject: (objectId: string) => ['relationships', 'object', objectId] as const,
	},
	triggers: {
		all: (workspaceId: string) => ['triggers', workspaceId] as const,
		detail: (id: string) => ['triggers', 'detail', id] as const,
	},
	integrations: {
		all: (workspaceId: string) => ['integrations', workspaceId] as const,
		providers: () => ['integrations', 'providers'] as const,
	},
	notifications: {
		all: (workspaceId: string) => ['notifications', workspaceId] as const,
		list: (workspaceId: string, filters?: Record<string, unknown>) =>
			['notifications', workspaceId, 'list', filters] as const,
		detail: (id: string) => ['notifications', 'detail', id] as const,
	},
	skills: {
		all: (actorId: string) => ['skills', actorId] as const,
		detail: (actorId: string, skillName: string) => ['skills', actorId, skillName] as const,
	},
	sessions: {
		all: (workspaceId: string) => ['sessions', workspaceId] as const,
		detail: (id: string) => ['sessions', 'detail', id] as const,
		logs: (sessionId: string) => ['sessions', sessionId, 'logs'] as const,
		byActor: (workspaceId: string, actorId: string) =>
			['sessions', workspaceId, 'actor', actorId, 'running'] as const,
	},
	events: {
		history: (workspaceId: string, filters?: Record<string, unknown>) =>
			['events', workspaceId, 'history', filters] as const,
		byEntity: (entityId: string) => ['events', 'entity', entityId] as const,
	},
	claudeOauth: {
		status: (workspaceId: string) => ['claude-oauth', workspaceId, 'status'] as const,
	},
} as const
