import type { SafeMetadata } from '@ai-native/shared'
import { getApiKey } from './auth'
import { API_BASE } from './constants'

export class ApiError extends Error {
	fieldErrors: Record<string, string[]>

	constructor(
		public status: number,
		message: string,
		fieldErrors?: Record<string, string[]>,
	) {
		super(message)
		this.name = 'ApiError'
		this.fieldErrors = fieldErrors ?? {}
	}

	hasFieldErrors(): boolean {
		return Object.keys(this.fieldErrors).length > 0
	}
}

type RequestOptions = {
	method?: string
	body?: unknown
	headers?: Record<string, string>
	workspaceId?: string
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const { method = 'GET', body, headers = {}, workspaceId } = opts
	const apiKey = getApiKey()

	const reqHeaders: Record<string, string> = {
		...headers,
	}

	if (apiKey) {
		reqHeaders.Authorization = `Bearer ${apiKey}`
	}
	if (workspaceId) {
		reqHeaders['X-Workspace-Id'] = workspaceId
	}
	if (body !== undefined) {
		reqHeaders['Content-Type'] = 'application/json'
	}

	const res = await fetch(`${API_BASE}${path}`, {
		method,
		headers: reqHeaders,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	})

	if (!res.ok) {
		const data = await res.json().catch(() => ({ error: res.statusText }))

		let fieldErrors: Record<string, string[]> | undefined
		let message: string

		if (typeof data.error === 'object' && data.error?.code) {
			// Structured error format: { error: { code, message, details?, suggestion? } }
			message = data.error.message
			if (data.error.details && Array.isArray(data.error.details)) {
				fieldErrors = {}
				for (const detail of data.error.details) {
					const field = detail.field || '_root'
					if (!fieldErrors[field]) fieldErrors[field] = []
					fieldErrors[field].push(detail.message)
				}
			}
		} else if (typeof data.error === 'string') {
			// TODO: Remove legacy string format fallback once all API responses use structured errors
			message = data.error
		} else {
			message = data.error?.message || res.statusText
		}

		throw new ApiError(res.status, message, fieldErrors)
	}

	return res.json()
}

// Objects
export const api = {
	objects: {
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<ObjectResponse[]>(`/objects${qs}`, { workspaceId })
		},
		get: (id: string) => request<ObjectResponse>(`/objects/${id}`),
		create: (workspaceId: string, data: CreateObjectInput) =>
			request<ObjectResponse>('/objects', { method: 'POST', body: data, workspaceId }),
		update: (id: string, data: UpdateObjectInput) =>
			request<ObjectResponse>(`/objects/${id}`, { method: 'PATCH', body: data }),
		delete: (id: string) => request<{ deleted: boolean }>(`/objects/${id}`, { method: 'DELETE' }),
	},

	auth: {
		login: (data: LoginInput) =>
			request<ActorWithKey>('/auth/login', { method: 'POST', body: data }),
	},

	actors: {
		list: (workspaceId?: string) => request<ActorListItem[]>('/actors', { workspaceId }),
		get: (id: string) => request<ActorResponse>(`/actors/${id}`),
		create: (data: CreateActorInput) =>
			request<ActorWithKey>('/actors', { method: 'POST', body: data }),
		update: (id: string, data: UpdateActorInput) =>
			request<ActorResponse>(`/actors/${id}`, { method: 'PATCH', body: data }),
		regenerateApiKey: (id: string) =>
			request<{ api_key: string }>(`/actors/${id}/api-keys`, { method: 'POST' }),
	},

	workspaces: {
		list: () => request<WorkspaceWithRole[]>('/workspaces'),
		update: (id: string, data: UpdateWorkspaceInput) =>
			request<WorkspaceResponse>(`/workspaces/${id}`, { method: 'PATCH', body: data }),
		members: {
			list: (workspaceId: string) =>
				request<MemberResponse[]>(`/workspaces/${workspaceId}/members`),
			add: (workspaceId: string, data: { actor_id: string; role?: string }) =>
				request<{ added: boolean }>(`/workspaces/${workspaceId}/members`, {
					method: 'POST',
					body: data,
				}),
		},
	},

	relationships: {
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<RelationshipResponse[]>(`/relationships${qs}`, { workspaceId })
		},
		create: (workspaceId: string, data: CreateRelationshipInput) =>
			request<RelationshipResponse>('/relationships', {
				method: 'POST',
				body: data,
				workspaceId,
			}),
		delete: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/relationships/${id}`, {
				method: 'DELETE',
				workspaceId,
			}),
	},

	triggers: {
		list: (workspaceId: string) => request<TriggerResponse[]>('/triggers', { workspaceId }),
		get: (id: string, workspaceId: string) =>
			request<TriggerResponse>(`/triggers/${id}`, { workspaceId }),
		create: (workspaceId: string, data: CreateTriggerInput) =>
			request<TriggerResponse>('/triggers', { method: 'POST', body: data, workspaceId }),
		update: (id: string, workspaceId: string, data: UpdateTriggerInput) =>
			request<TriggerResponse>(`/triggers/${id}`, {
				method: 'PATCH',
				body: data,
				workspaceId,
			}),
		delete: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/triggers/${id}`, {
				method: 'DELETE',
				workspaceId,
			}),
	},

	integrations: {
		list: (workspaceId: string) => request<IntegrationResponse[]>('/integrations', { workspaceId }),
		providers: () => request<ProviderInfo[]>('/integrations/providers'),
		connect: (workspaceId: string, provider: string) =>
			request<{ install_url: string }>(`/integrations/${provider}/connect`, {
				method: 'POST',
				workspaceId,
			}),
		disconnect: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/integrations/${id}`, {
				method: 'DELETE',
				workspaceId,
			}),
	},

	notifications: {
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<NotificationResponse[]>(`/notifications${qs}`, { workspaceId })
		},
		get: (id: string) => request<NotificationResponse>(`/notifications/${id}`),
		update: (id: string, data: UpdateNotificationInput) =>
			request<NotificationResponse>(`/notifications/${id}`, { method: 'PATCH', body: data }),
		respond: (id: string, response: unknown, workspaceId: string) =>
			request<NotificationResponse>(`/notifications/${id}/respond`, {
				method: 'POST',
				body: { response },
				workspaceId,
			}),
		delete: (id: string) =>
			request<{ deleted: boolean }>(`/notifications/${id}`, { method: 'DELETE' }),
	},

	skills: {
		list: (actorId: string, workspaceId: string) =>
			request<SkillListItem[]>(`/actors/${actorId}/skills`, { workspaceId }),
		get: (actorId: string, skillName: string, workspaceId: string) =>
			request<SkillDetail>(`/actors/${actorId}/skills/${skillName}`, { workspaceId }),
		save: (actorId: string, skillName: string, data: SaveSkillInput, workspaceId: string) =>
			request<SkillDetail>(`/actors/${actorId}/skills/${skillName}`, {
				method: 'PUT',
				body: data,
				workspaceId,
			}),
		delete: (actorId: string, skillName: string, workspaceId: string) =>
			request<{ ok: boolean }>(`/actors/${actorId}/skills/${skillName}`, {
				method: 'DELETE',
				workspaceId,
			}),
	},

	sessions: {
		create: (workspaceId: string, data: CreateSessionInput) =>
			request<SessionResponse>('/sessions', { method: 'POST', body: data, workspaceId }),
		get: (id: string, workspaceId: string) =>
			request<SessionResponse>(`/sessions/${id}`, { workspaceId }),
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<SessionResponse[]>(`/sessions${qs}`, { workspaceId })
		},
		logs: (id: string, workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<SessionLogResponse[]>(`/sessions/${id}/logs${qs}`, { workspaceId })
		},
		retry: (id: string, workspaceId: string) =>
			request<SessionResponse>(`/sessions/${id}/retry`, { method: 'POST', workspaceId }),
	},

	events: {
		history: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<EventResponse[]>(`/events/history${qs}`, { workspaceId })
		},
		create: (workspaceId: string, data: CreateCommentInput) =>
			request<EventResponse>('/events', { method: 'POST', body: data, workspaceId }),
	},

	claudeOauth: {
		import: (workspaceId: string, tokens: ClaudeOAuthImportInput) =>
			request<ClaudeOAuthExchangeResponse>('/claude-oauth/import', {
				method: 'POST',
				body: tokens,
				workspaceId,
			}),
		status: (workspaceId: string) =>
			request<ClaudeOAuthStatusResponse>('/claude-oauth/status', { workspaceId }),
		disconnect: (workspaceId: string) =>
			request<{ success: boolean }>('/claude-oauth', {
				method: 'DELETE',
				workspaceId,
			}),
	},
}

export interface ClaudeOAuthExchangeResponse {
	success: boolean
	subscription_type?: string
	expires_at: number
}

export interface ClaudeOAuthStatusResponse {
	connected: boolean
	subscription_type?: string
	expires_at?: number
	valid: boolean
}

export interface ClaudeOAuthImportInput {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
}

// Types derived from backend response schemas
export interface ObjectResponse {
	id: string
	workspaceId: string
	type: string
	title: string | null
	content: string | null
	status: string
	metadata: SafeMetadata | null
	owner: string | null
	activeSessionId: string | null
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
}

export interface CreateObjectInput {
	id?: string
	type: string
	title?: string
	content?: string
	status: string
	metadata?: SafeMetadata
	owner?: string
}

export interface UpdateObjectInput {
	title?: string
	content?: string
	status?: string
	metadata?: SafeMetadata
	owner?: string | null
}

export interface ActorListItem {
	id: string
	type: string
	name: string
	email: string | null
}

export interface ActorResponse extends ActorListItem {
	systemPrompt: string | null
	tools: Record<string, unknown> | null
	memory: Record<string, unknown> | null
	llmProvider: string | null
	llmConfig: Record<string, unknown> | null
	createdAt: string | null
	updatedAt: string | null
}

export interface ActorWithKey extends ActorResponse {
	api_key: string
}

export interface LoginInput {
	email: string
	password: string
}

export interface CreateActorInput {
	id?: string
	type: 'human' | 'agent'
	name: string
	email?: string
	password?: string
	system_prompt?: string
	tools?: Record<string, unknown>
	llm_provider?: string
	llm_config?: Record<string, unknown>
}

export interface UpdateActorInput {
	name?: string
	email?: string
	system_prompt?: string
	tools?: Record<string, unknown>
	memory?: Record<string, unknown>
	llm_provider?: string
	llm_config?: Record<string, unknown>
}

export interface WorkspaceResponse {
	id: string
	name: string
	settings: Record<string, unknown>
	createdBy: string | null
	createdAt: string | null
	updatedAt: string | null
}

export interface WorkspaceWithRole extends WorkspaceResponse {
	role: string
}

export interface UpdateWorkspaceInput {
	name?: string
	settings?: Record<string, unknown>
}

export interface MemberResponse {
	actorId: string
	role: string
	joinedAt: string | null
	name: string
	type: string
}

export interface RelationshipResponse {
	id: string
	sourceType: string
	sourceId: string
	targetType: string
	targetId: string
	type: string
	createdBy: string
	createdAt: string | null
}

export interface CreateRelationshipInput {
	source_type: string
	source_id: string
	target_type: string
	target_id: string
	type: string
}

export interface TriggerResponse {
	id: string
	workspaceId: string
	name: string
	type: string
	config: Record<string, unknown> | null
	actionPrompt: string
	targetActorId: string
	enabled: boolean
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
}

export interface CreateTriggerInput {
	name: string
	type: 'cron' | 'event' | 'reminder'
	config: Record<string, unknown>
	action_prompt: string
	target_actor_id: string
	enabled?: boolean
}

export interface UpdateTriggerInput {
	name?: string
	config?: Record<string, unknown>
	action_prompt?: string
	target_actor_id?: string
	enabled?: boolean
}

export interface IntegrationResponse {
	id: string
	workspaceId: string
	provider: string
	status: string
	externalId: string | null
	config: Record<string, unknown>
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
}

export interface ProviderEventDefinition {
	entityType: string
	actions: string[]
	label: string
}

export interface ProviderInfo {
	name: string
	displayName: string
	events: ProviderEventDefinition[]
}

export interface NotificationResponse {
	id: string
	workspaceId: string
	type: string
	title: string
	content: string | null
	metadata: SafeMetadata | null
	sourceActorId: string
	targetActorId: string | null
	objectId: string | null
	sessionId: string | null
	status: string
	resolvedAt: string | null
	createdAt: string | null
	updatedAt: string | null
}

export interface UpdateNotificationInput {
	status?: 'pending' | 'seen' | 'resolved' | 'dismissed'
	metadata?: SafeMetadata
}

export interface SkillListItem {
	name: string
	description: string
	size_bytes: number | null
	updated_at: string | null
}

export interface SkillDetail extends SkillListItem {
	content: string
	frontmatter: Record<string, unknown>
}

export interface SaveSkillInput {
	description: string
	content: string
	frontmatter?: Record<string, unknown>
}

export interface CreateSessionInput {
	actor_id: string
	action_prompt: string
	auto_start?: boolean
}

export interface SessionResponse {
	id: string
	workspaceId: string
	actorId: string
	triggerId: string | null
	status: string
	containerId: string | null
	actionPrompt: string
	config: Record<string, unknown> | null
	result: Record<string, unknown> | null
	snapshotPath: string | null
	startedAt: string | null
	completedAt: string | null
	timeoutAt: string | null
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
}

export interface SessionLogResponse {
	id: number
	sessionId: string
	stream: string
	content: string
	createdAt: string | null
}

export interface EventResponse {
	id: number
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data: Record<string, unknown> | null
	createdAt: string | null
}

export interface CreateCommentInput {
	entity_id: string
	content: string
	mentions?: string[]
	parent_event_id?: number
}
