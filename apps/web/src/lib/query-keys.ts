export const queryKeys = {
	objects: {
		all: (workspaceId: string) => ['objects', workspaceId] as const,
		list: (workspaceId: string, filters?: Record<string, unknown>) =>
			['objects', workspaceId, 'list', filters] as const,
		listPrefix: (workspaceId: string) => ['objects', workspaceId, 'list'] as const,
		listInfinite: (workspaceId: string, filters?: Record<string, unknown>) =>
			['objects', workspaceId, 'listInfinite', filters] as const,
		listInfinitePrefix: (workspaceId: string) => ['objects', workspaceId, 'listInfinite'] as const,
		board: (workspaceId: string, filters?: Record<string, unknown>) =>
			['objects', workspaceId, 'board', filters] as const,
		boardPrefix: (workspaceId: string) => ['objects', workspaceId, 'board'] as const,
		detail: (id: string) => ['objects', 'detail', id] as const,
		graph: (id: string) => ['objects', 'graph', id] as const,
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
	},
	triggers: {
		all: (workspaceId: string) => ['triggers', workspaceId] as const,
		detail: (id: string) => ['triggers', 'detail', id] as const,
	},
	integrations: {
		all: (workspaceId: string) => ['integrations', workspaceId] as const,
		providers: () => ['integrations', 'providers'] as const,
		slackConversations: (integrationId: string, types: string[]) =>
			['integrations', integrationId, 'slack', 'conversations', [...types].sort()] as const,
		slackUsers: (integrationId: string) =>
			['integrations', integrationId, 'slack', 'users'] as const,
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
	workspaceSkills: {
		all: (workspaceId: string) => ['workspace-skills', workspaceId] as const,
		detail: (workspaceId: string, name: string) => ['workspace-skills', workspaceId, name] as const,
	},
	agentSkillAttachments: {
		all: (actorId: string) => ['agent-skill-attachments', actorId] as const,
	},
	sessions: {
		all: (workspaceId: string) => ['sessions', workspaceId] as const,
		detail: (id: string) => ['sessions', 'detail', id] as const,
		logs: (sessionId: string) => ['sessions', sessionId, 'logs'] as const,
		byActor: (workspaceId: string, actorId: string) =>
			['sessions', workspaceId, 'actor', actorId, 'running'] as const,
		byActorAllInfinite: (workspaceId: string, actorId: string) =>
			['sessions', workspaceId, 'actor', actorId, 'all', 'infinite'] as const,
		byMentionObject: (workspaceId: string, objectId: string) =>
			['sessions', workspaceId, 'mention-object', objectId] as const,
		usage: (
			workspaceId: string,
			actorId: string,
			range: { from: string; to: string; bucket: string },
		) => ['sessions', workspaceId, 'actor', actorId, 'usage', range] as const,
	},
	events: {
		history: (workspaceId: string, filters?: Record<string, unknown>) =>
			['events', workspaceId, 'history', filters] as const,
		byEntity: (entityId: string) => ['events', 'entity', entityId] as const,
	},
	imports: {
		all: (workspaceId: string) => ['imports', workspaceId] as const,
		detail: (id: string) => ['imports', 'detail', id] as const,
	},
	files: {
		all: (workspaceId: string) => ['files', workspaceId] as const,
		detail: (workspaceId: string, id: string) => ['files', workspaceId, 'detail', id] as const,
	},
	claudeOauth: {
		status: (workspaceId: string) => ['claude-oauth', workspaceId, 'status'] as const,
	},
	billing: {
		usage: (workspaceId: string) => ['billing', workspaceId, 'usage'] as const,
	},
	subscriptions: {
		subscribers: (entityType: string, entityId: string) =>
			['subscriptions', 'subscribers', entityType, entityId] as const,
		unread: (workspaceId: string, entityType?: string) =>
			['subscriptions', 'unread', workspaceId, entityType ?? 'all'] as const,
	},
	userDisplaySettings: {
		list: (workspaceId: string) => ['user-display-settings', workspaceId, 'list'] as const,
		detail: (workspaceId: string, objectType: string) =>
			['user-display-settings', workspaceId, 'detail', objectType] as const,
	},
} as const
