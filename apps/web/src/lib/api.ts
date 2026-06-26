import type {
	ActorListItem,
	ActorResponse,
	DisplaySettingsBody,
	SafeMetadata,
	TriggerResponse,
} from '@maskin/shared'

export type { ActorListItem, ActorResponse, DisplaySettingsBody, TriggerResponse }
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

/**
 * XHR-based file upload that reports byte-level progress via onProgress.
 * fetch() does not expose upload progress; we use this only for file uploads
 * where the user benefits from a real progress bar. Supports cancellation via
 * AbortSignal (mirrors fetch's contract).
 */
function uploadFileWithProgress(
	workspaceId: string,
	body: CreateFileInput,
	opts?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
): Promise<FileDetail> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest()
		const url = `${API_BASE}/files`
		xhr.open('POST', url, true)
		const apiKey = getApiKey()
		if (apiKey) xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`)
		xhr.setRequestHeader('X-Workspace-Id', workspaceId)
		xhr.setRequestHeader('Content-Type', 'application/json')

		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && opts?.onProgress) {
				opts.onProgress(e.loaded / e.total)
			}
		}
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve(JSON.parse(xhr.responseText))
				} catch (err) {
					reject(new ApiError(xhr.status, `Invalid JSON response: ${String(err)}`))
				}
				return
			}
			let message = xhr.statusText
			let fieldErrors: Record<string, string[]> | undefined
			try {
				const data = JSON.parse(xhr.responseText)
				if (typeof data.error === 'object' && data.error?.message) {
					message = data.error.message
					if (Array.isArray(data.error.details)) {
						fieldErrors = {}
						for (const d of data.error.details) {
							const field = d.field || '_root'
							if (!fieldErrors[field]) fieldErrors[field] = []
							fieldErrors[field].push(d.message)
						}
					}
				} else if (typeof data.error === 'string') {
					message = data.error
				}
			} catch {
				// keep statusText
			}
			reject(new ApiError(xhr.status, message, fieldErrors))
		}
		xhr.onerror = () => reject(new ApiError(0, 'Network error'))
		xhr.onabort = () => reject(new ApiError(0, 'Upload aborted'))

		if (opts?.signal) {
			if (opts.signal.aborted) {
				xhr.abort()
				return
			}
			opts.signal.addEventListener('abort', () => xhr.abort(), { once: true })
		}

		xhr.send(JSON.stringify(body))
	})
}

// Objects
export const api = {
	objects: {
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<ObjectResponse[]>(`/objects${qs}`, { workspaceId })
		},
		board: (workspaceId: string, params: Record<string, string>) => {
			const qs = `?${new URLSearchParams(params)}`
			return request<BoardObjectResponse>(`/objects/board${qs}`, { workspaceId })
		},
		get: (id: string) => request<ObjectResponse>(`/objects/${id}`),
		graph: (id: string, workspaceId: string) =>
			request<ObjectGraphResponse>(`/objects/${id}/graph`, { workspaceId }),
		create: (workspaceId: string, data: CreateObjectInput) =>
			request<ObjectResponse>('/objects', { method: 'POST', body: data, workspaceId }),
		update: (id: string, data: UpdateObjectInput) =>
			request<ObjectResponse>(`/objects/${id}`, { method: 'PATCH', body: data }),
		delete: (id: string) => request<{ deleted: boolean }>(`/objects/${id}`, { method: 'DELETE' }),
		search: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<ObjectResponse[]>(`/objects/search${qs}`, { workspaceId })
		},
		migrateType: (workspaceId: string, body: MigrateObjectTypeInput) =>
			request<MigrateObjectTypeResponse>('/objects/migrate-type', {
				method: 'POST',
				body,
				workspaceId,
			}),
		bulkUpdate: (workspaceId: string, body: BulkUpdateObjectsInput) =>
			request<BulkUpdateObjectsResponse>('/objects/bulk-update', {
				method: 'POST',
				body,
				workspaceId,
			}),
	},

	auth: {
		login: (data: LoginInput) =>
			request<ActorWithKey>('/auth/login', { method: 'POST', body: data }),
	},

	landingEvents: {
		emit: (events: Array<{ name: string; anonId: string; props?: Record<string, unknown> }>) =>
			request<void>('/public/landing-events', { method: 'POST', body: { events } }),
	},

	// Public landing-page handoffs. The /drafts endpoint is unauthenticated and
	// called from sindre.ai; only /claim is reachable from the web app.
	publicBetStrategist: {
		claim: (workspaceId: string, guestSessionId: string) =>
			request<{ claimed: Array<{ id: string; title: string | null; content: string | null }> }>(
				'/public/bet-strategist/claim',
				{ method: 'POST', body: { workspace_id: workspaceId, guestSessionId } },
			),
	},

	actors: {
		list: (workspaceId?: string) => request<ActorListItem[]>('/actors', { workspaceId }),
		get: (id: string) => request<ActorResponse>(`/actors/${id}`),
		create: (data: CreateActorInput) =>
			request<ActorWithKey>('/actors', { method: 'POST', body: data }),
		update: (id: string, data: UpdateActorInput, workspaceId?: string) =>
			request<ActorResponse>(`/actors/${id}`, {
				method: 'PATCH',
				body: data,
				workspaceId,
			}),
		regenerateApiKey: (id: string) =>
			request<{ api_key: string }>(`/actors/${id}/api-keys`, { method: 'POST' }),
		reset: (id: string, workspaceId: string) =>
			request<ActorResponse>(`/actors/${id}/reset`, { method: 'POST', workspaceId }),
		pause: (id: string, workspaceId: string) =>
			request<ActorResponse>(`/actors/${id}/pause`, { method: 'POST', workspaceId }),
		run: (id: string, workspaceId: string, body?: RunAgentInput) =>
			request<ActorResponse>(`/actors/${id}/run`, {
				method: 'POST',
				body: body ?? {},
				workspaceId,
			}),
		delete: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/actors/${id}`, { method: 'DELETE', workspaceId }),
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
		connect: (workspaceId: string, provider: string, body?: { api_key?: string }) =>
			request<{ install_url: string }>(`/integrations/${provider}/connect`, {
				method: 'POST',
				body,
				workspaceId,
			}),
		disconnect: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/integrations/${id}`, {
				method: 'DELETE',
				workspaceId,
			}),
		slackConversations: (id: string, workspaceId: string, types?: string[]) => {
			const qs = types && types.length > 0 ? `?types=${types.join(',')}` : ''
			return request<SlackConversation[]>(`/integrations/${id}/slack/conversations${qs}`, {
				workspaceId,
			})
		},
		slackUsers: (id: string, workspaceId: string) =>
			request<SlackUser[]>(`/integrations/${id}/slack/users`, { workspaceId }),
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
		input: (id: string, body: SessionInputBody, workspaceId: string) =>
			request<{ ok: true }>(`/sessions/${id}/input`, {
				method: 'POST',
				body,
				workspaceId,
			}),
		stop: (id: string, workspaceId: string) =>
			request<SessionResponse>(`/sessions/${id}/stop`, { method: 'POST', workspaceId }),
		usage: (
			workspaceId: string,
			params: { actor_id: string; from: string; to: string; bucket: 'hour' | 'day' | 'week' },
		) => {
			const qs = new URLSearchParams(params).toString()
			return request<SessionUsageResponse>(`/sessions/usage?${qs}`, { workspaceId })
		},
	},

	events: {
		history: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<EventResponse[]>(`/events/history${qs}`, { workspaceId })
		},
		create: (workspaceId: string, data: CreateCommentInput, idempotencyKey?: string) =>
			request<EventResponse>('/events', {
				method: 'POST',
				body: data,
				workspaceId,
				headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
			}),
	},

	imports: {
		create: async (workspaceId: string, file: File): Promise<ImportResponse> => {
			const apiKey = getApiKey()
			const formData = new FormData()
			formData.append('file', file)
			const res = await fetch(`${API_BASE}/imports`, {
				method: 'POST',
				headers: {
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					'X-Workspace-Id': workspaceId,
				},
				body: formData,
			})
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: res.statusText }))
				const message =
					typeof data.error === 'object' ? data.error.message : data.error || res.statusText
				throw new ApiError(res.status, message)
			}
			return res.json()
		},
		get: (id: string, workspaceId: string) =>
			request<ImportResponse>(`/imports/${id}`, { workspaceId }),
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<ImportListItem[]>(`/imports${qs}`, { workspaceId })
		},
		updateMapping: (id: string, mapping: ImportMappingInput, workspaceId: string) =>
			request<ImportResponse>(`/imports/${id}/mapping`, {
				method: 'PATCH',
				body: { mapping },
				workspaceId,
			}),
		confirm: (id: string, workspaceId: string) =>
			request<ImportResponse>(`/imports/${id}/confirm`, { method: 'POST', workspaceId }),
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
		disconnect: (workspaceId: string, slot?: ClaudeOAuthSlot) =>
			request<{ success: boolean }>(slot ? `/claude-oauth?slot=${slot}` : '/claude-oauth', {
				method: 'DELETE',
				workspaceId,
			}),
		swap: (workspaceId: string) =>
			request<{ success: boolean }>('/claude-oauth/swap', { method: 'POST', workspaceId }),
	},

	catalogPackages: {
		list: (params?: { type?: string; use_case?: string; q?: string }) => {
			const qs = params
				? `?${new URLSearchParams(
						Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
					)}`
				: ''
			return request<CatalogPackagesListResponse>(`/catalog/packages${qs}`)
		},
		get: (id: string) => request<CatalogPackageDetailResponse>(`/catalog/packages/${id}`),
	},

	catalogItems: {
		install: (itemId: string, workspaceId: string) =>
			request<CatalogItemInstallResponse>(`/catalog/items/${encodeURIComponent(itemId)}/install`, {
				method: 'POST',
				body: { workspaceId },
				workspaceId,
			}),
		installed: (workspaceId: string) =>
			request<CatalogItemsInstalledResponse>(
				`/catalog/items/installed?workspaceId=${encodeURIComponent(workspaceId)}`,
				{ workspaceId },
			),
		uninstall: (itemId: string, workspaceId: string, keepProvisionedItems: boolean) =>
			request<{ deleted: boolean }>(`/catalog/items/${encodeURIComponent(itemId)}/uninstall`, {
				method: 'DELETE',
				body: { workspaceId, keepProvisionedItems },
				workspaceId,
			}),
	},

	installedPackages: {
		list: (workspaceId: string) =>
			request<InstalledPackagesListResponse>(
				`/installed-packages?workspaceId=${encodeURIComponent(workspaceId)}`,
				{ workspaceId },
			),
		install: (workspaceId: string, packageId: string) =>
			request<InstalledPackageInstallResponse>('/installed-packages', {
				method: 'POST',
				body: { packageId, workspaceId },
				workspaceId,
			}),
		fork: (workspaceId: string, installedPackageId: string) =>
			request<InstalledPackageForkResponse>(`/installed-packages/${installedPackageId}/fork`, {
				method: 'POST',
				workspaceId,
			}),
		uninstall: (workspaceId: string, installedPackageId: string, keepProvisionedItems: boolean) =>
			request<{ deleted: boolean }>(`/installed-packages/${installedPackageId}`, {
				method: 'DELETE',
				body: { keepProvisionedItems },
				workspaceId,
			}),
	},

	subscriptions: {
		subscribe: (workspaceId: string, entityType: string, entityId: string) =>
			request<{ subscribed: true }>('/subscriptions', {
				method: 'POST',
				body: { entity_type: entityType, entity_id: entityId },
				workspaceId,
			}),
		unsubscribe: (workspaceId: string, entityType: string, entityId: string) =>
			request<{ unsubscribed: true }>('/subscriptions', {
				method: 'DELETE',
				body: { entity_type: entityType, entity_id: entityId },
				workspaceId,
			}),
		subscribers: (workspaceId: string, entityType: string, entityId: string) => {
			const qs = new URLSearchParams({ entity_type: entityType, entity_id: entityId }).toString()
			return request<SubscribersResponse>(`/subscriptions/subscribers?${qs}`, { workspaceId })
		},
		markRead: (workspaceId: string, entityType: string, entityId: string, lastEventId: number) =>
			request<{ updated: true }>('/subscriptions/read', {
				method: 'POST',
				body: { entity_type: entityType, entity_id: entityId, last_event_id: lastEventId },
				workspaceId,
			}),
		unread: (workspaceId: string, entityType?: string) => {
			const qs = entityType ? `?${new URLSearchParams({ entity_type: entityType }).toString()}` : ''
			return request<UnreadResponse>(`/subscriptions/unread${qs}`, { workspaceId })
		},
	},

	userDisplaySettings: {
		list: (workspaceId: string) =>
			request<UserDisplaySettingsListResponse>('/user-display-settings', { workspaceId }),
		get: (workspaceId: string, objectType: string) =>
			request<UserDisplaySettingsResponse>(
				`/user-display-settings/${encodeURIComponent(objectType)}`,
				{ workspaceId },
			),
		upsert: (workspaceId: string, objectType: string, settings: DisplaySettingsBody) =>
			request<UserDisplaySettingsResponse>(
				`/user-display-settings/${encodeURIComponent(objectType)}`,
				{ method: 'PUT', body: { settings }, workspaceId },
			),
	},

	workspaceSkills: {
		list: (workspaceId: string) =>
			request<WorkspaceSkillListItem[]>(`/workspaces/${workspaceId}/skills`, { workspaceId }),
		get: (workspaceId: string, name: string) =>
			request<WorkspaceSkillDetail>(`/workspaces/${workspaceId}/skills/${name}`, { workspaceId }),
		create: (workspaceId: string, data: CreateWorkspaceSkillInput) =>
			request<WorkspaceSkillDetail>(`/workspaces/${workspaceId}/skills`, {
				method: 'POST',
				body: data,
				workspaceId,
			}),
		update: (workspaceId: string, name: string, data: UpdateWorkspaceSkillInput) =>
			request<WorkspaceSkillDetail>(`/workspaces/${workspaceId}/skills/${name}`, {
				method: 'PUT',
				body: data,
				workspaceId,
			}),
		delete: (workspaceId: string, name: string) =>
			request<{ deleted: boolean }>(`/workspaces/${workspaceId}/skills/${name}`, {
				method: 'DELETE',
				workspaceId,
			}),
		listForActor: (actorId: string) =>
			request<AttachedWorkspaceSkill[]>(`/actors/${actorId}/workspace-skills`),
		attach: (actorId: string, workspaceSkillId: string) =>
			request<AttachedWorkspaceSkill>(`/actors/${actorId}/workspace-skills`, {
				method: 'POST',
				body: { workspaceSkillId },
			}),
		detach: (actorId: string, workspaceSkillId: string) =>
			request<{ deleted: boolean }>(`/actors/${actorId}/workspace-skills/${workspaceSkillId}`, {
				method: 'DELETE',
			}),
	},

	files: {
		list: (
			workspaceId: string,
			params?: { q?: string; ids?: string[]; limit?: number; offset?: number },
		) => {
			if (!params) return request<FileListItem[]>('/files', { workspaceId })
			const { ids, ...rest } = params
			const searchParams = new URLSearchParams(
				Object.entries(rest).reduce<Record<string, string>>((acc, [k, v]) => {
					if (v !== undefined && v !== '') acc[k] = String(v)
					return acc
				}, {}),
			)
			if (ids?.length) searchParams.set('ids', ids.join(','))
			const qs = searchParams.size > 0 ? `?${searchParams}` : ''
			return request<FileListItem[]>(`/files${qs}`, { workspaceId })
		},
		get: (workspaceId: string, id: string) => request<FileDetail>(`/files/${id}`, { workspaceId }),
		create: (workspaceId: string, data: CreateFileInput) =>
			request<FileDetail>('/files', { method: 'POST', body: data, workspaceId }),
		createWithProgress: (
			workspaceId: string,
			data: CreateFileInput,
			opts?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
		) => uploadFileWithProgress(workspaceId, data, opts),
		update: (workspaceId: string, id: string, data: UpdateFileInput) =>
			request<FileDetail>(`/files/${id}`, { method: 'PATCH', body: data, workspaceId }),
		delete: (workspaceId: string, id: string) =>
			request<{ deleted: boolean }>(`/files/${id}`, { method: 'DELETE', workspaceId }),
	},
}

export type ClaudeOAuthSlot = 'primary' | 'backup'

export interface ClaudeOAuthSlotInfo {
	subscription_type?: string
	expires_at: number
}

export interface ClaudeOAuthExchangeResponse {
	success: boolean
	slot?: ClaudeOAuthSlot
	subscription_type?: string
	expires_at: number
}

export interface ClaudeOAuthStatusResponse {
	connected: boolean
	subscription_type?: string
	expires_at?: number
	valid: boolean
	slots: {
		primary?: ClaudeOAuthSlotInfo
		backup?: ClaudeOAuthSlotInfo
	}
	active_slot: ClaudeOAuthSlot
	last_primary_failure_at?: number
	last_classified_reason?: string
}

export interface ClaudeOAuthImportInput {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
	slot?: ClaudeOAuthSlot
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
	driver: string | null
	activeSessionId: string | null
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
	// Populated by detail / graph routes only — list routes omit to avoid N+1.
	is_subscribed?: boolean
	unread_count?: number
	subscriber_count?: number
}

export interface BoardObjectColumn {
	id: string
	label: string
	value: string
	total: number
	objects: ObjectResponse[]
}

export interface BoardObjectResponse {
	columns: BoardObjectColumn[]
}

export interface SubscribersResponse {
	actors: Array<{ id: string; type: string; name: string }>
}

export interface UnreadItem {
	entity_type: string
	entity_id: string
	unread_count: number
	mentions_you: boolean
	latest_event_id: number | null
	latest_activity_at: string | null
	object?: ObjectResponse
}

export interface UnreadResponse {
	items: UnreadItem[]
}

export interface UserDisplaySettingsResponse {
	object_type: string
	name: string
	settings: DisplaySettingsBody
	updated_at: string
}

export interface UserDisplaySettingsListResponse {
	items: UserDisplaySettingsResponse[]
}

export interface CreateObjectInput {
	id?: string
	type: string
	title?: string
	content?: string
	status: string
	metadata?: SafeMetadata
	driver?: string
}

export interface UpdateObjectInput {
	title?: string
	content?: string
	status?: string
	metadata?: SafeMetadata
	driver?: string | null
}

export interface BulkUpdateObjectsInput {
	ids: string[]
	patch: {
		status?: string
		driver?: string | null
		metadata?: SafeMetadata
	}
}

export interface BulkUpdateObjectsResult {
	id: string
	ok: boolean
	error?: string
}

export interface BulkUpdateObjectsResponse {
	results: BulkUpdateObjectsResult[]
}

export interface MigrateObjectTypeInput {
	fromType: string
	mode: 'migrate' | 'delete'
	toType?: string
	statusMap?: Record<string, string>
}

export interface MigrateObjectTypeResponse {
	mode: 'migrate' | 'delete'
	fromType: string
	toType?: string
	count: number
}

export interface ActorWithKey extends ActorResponse {
	api_key: string
	// Set when the actor is created with `auto_create_workspace` (default for
	// humans on signup). Used by the signup → guest-draft handoff to pick the
	// workspace to claim into.
	workspace_id?: string
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
	description?: string
	system_prompt?: string
	tools?: Record<string, unknown>
	llm_provider?: string
	llm_config?: Record<string, unknown>
}

export interface UpdateActorInput {
	name?: string
	email?: string
	description?: string
	system_prompt?: string
	tools?: Record<string, unknown>
	memory?: Record<string, unknown>
	llm_provider?: string
	llm_config?: Record<string, unknown>
}

export interface RunAgentInput {
	action_prompt?: string
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
	sourceTitle?: string | null
	targetType: string
	targetId: string
	targetTitle?: string | null
	type: string
	createdBy: string
	createdAt: string | null
}

export interface ObjectGraphResponse {
	object: ObjectResponse
	relationships: RelationshipResponse[]
	connected_objects: ObjectResponse[]
	events: EventResponse[]
}

export interface CreateRelationshipInput {
	source_type: string
	source_id: string
	target_type: string
	target_id: string
	type: string
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
	authType: 'oauth2' | 'oauth2_custom' | 'api_key'
	events: ProviderEventDefinition[]
}

export interface SlackConversation {
	id: string
	name: string
	is_private: boolean
	is_im: boolean
	is_mpim: boolean
	is_channel: boolean
}

export interface SlackUser {
	id: string
	name: string
	real_name: string
	is_bot: boolean
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

export interface WorkspaceSkillListItem {
	id: string
	workspaceId: string
	name: string
	description: string | null
	storageKey: string
	sizeBytes: number
	isValid: boolean
	createdBy: string | null
	createdAt: string
	updatedAt: string
}

export interface WorkspaceSkillDetail extends WorkspaceSkillListItem {
	content: string
}

export interface AttachedWorkspaceSkill extends WorkspaceSkillListItem {
	attachedAt: string
}

export interface CreateWorkspaceSkillInput {
	name: string
	content: string
}

export interface UpdateWorkspaceSkillInput {
	name?: string
	content: string
}

export interface FileListItem {
	id: string
	workspaceId: string
	name: string
	description: string | null
	mimeType: string
	sizeBytes: number
	storageKey: string
	createdBy: string
	createdAt: string
	updatedAt: string
}

export interface FileAnnotation {
	id: string
	pinNumber?: number
	selector: string
	bounds: { x: number; y: number; w: number; h: number }
	comment: string
	position?: { x: number; y: number }
}

export interface FileDetail extends FileListItem {
	content: string
	encoding: 'base64' | 'utf8'
	url: string
	annotations: FileAnnotation[]
}

export interface CreateFileInput {
	name: string
	description?: string | null
	mime_type: string
	content: string
	encoding?: 'base64' | 'utf8'
}

export interface UpdateFileInput {
	name?: string
	description?: string | null
	mime_type?: string
	content?: string
	encoding?: 'base64' | 'utf8'
	annotations?: FileAnnotation[]
}

export interface SessionConfigInput {
	/** Start the container with stdin attached so subsequent user turns can be delivered via the input route. */
	interactive?: boolean
	base_image?: string
	runtime?: 'claude-code' | 'codex' | 'custom'
	timeout_seconds?: number
	memory_mb?: number
	cpu_shares?: number
	env_vars?: Record<string, string>
	mcps?: Array<Record<string, unknown>>
}

export interface CreateSessionInput {
	actor_id: string
	action_prompt: string
	config?: SessionConfigInput
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
	currentActivity: string | null
}

export interface SessionInputAttachment {
	kind: string
	id: string
}

export interface SessionInputBody {
	content: string
	attachments?: SessionInputAttachment[]
}

export interface SessionLogResponse {
	id: number
	sessionId: string
	stream: string
	content: string
	createdAt: string | null
}

export interface SessionUsageBucketResponse {
	bucket: string
	session_count: number
	total_cost_usd: number
	input_tokens: number
	output_tokens: number
	cache_tokens: number
}

export interface SessionUsageResponse {
	buckets: SessionUsageBucketResponse[]
	totals: {
		session_count: number
		total_cost_usd: number
		input_tokens: number
		output_tokens: number
		cache_tokens: number
	}
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
	/** Pre-formatted human-readable sentence (populated by /api/objects/:id/graph; absent on other event endpoints). */
	description?: string
}

export interface CreateCommentInput {
	entity_id: string
	content: string
	mentions?: string[]
	parent_event_id?: number
	attachment_file_ids?: string[]
}

// Imports
export interface CsvOptions {
	delimiter?: ',' | ';' | '\t' | '|'
	encoding?: 'utf-8' | 'latin-1'
}

export interface ImportResponse {
	id: string
	workspaceId: string
	status: string
	fileName: string
	fileType: string
	totalRows: number | null
	processedRows: number
	successCount: number
	errorCount: number
	mapping: ImportMappingInput | null
	preview: ImportPreview | null
	errors: ImportError[] | null
	source: string
	createdBy: string
	createdAt: string | null
	updatedAt: string | null
	completedAt: string | null
}

export type ImportListItem = Omit<ImportResponse, 'mapping' | 'preview' | 'errors'>

export interface ImportPreview {
	columns: string[]
	sampleRows: Record<string, string>[]
	totalRows: number
}

export interface ImportError {
	row: number
	column?: string
	message: string
	value?: string
}

export interface ColumnMappingInput {
	sourceColumn: string
	targetField: string
	transform: 'none' | 'date' | 'number' | 'boolean'
	skip: boolean
}

export interface TypeMappingInput {
	objectType: string
	columns: ColumnMappingInput[]
	defaultStatus?: string
}

export interface RelationshipMappingInput {
	sourceType: string
	relationshipType: string
	targetType: string
}

export interface ImportMappingInput {
	typeMappings: TypeMappingInput[]
	relationships?: RelationshipMappingInput[]
	csvOptions?: CsvOptions
}

export type CatalogItemType = 'actor' | 'trigger' | 'skill' | 'integration'

export interface CatalogPackageSummary {
	id: string
	name: string
	slug: string
	description: string
	version: string
	use_case: string | null
	item_types: CatalogItemType[]
	created_at: string | null
	updated_at: string | null
}

export interface CatalogPackageItem {
	id: string
	package_id: string
	item_type: CatalogItemType
	source_item_id: string
	item_snapshot: Record<string, unknown>
	created_at: string | null
}

export interface CatalogPackageCounts {
	total: number
	by_type: Record<CatalogItemType, number>
	by_use_case: Record<string, number>
}

export interface CatalogPackagesListResponse {
	packages: CatalogPackageSummary[]
	counts: CatalogPackageCounts
}

export interface CatalogPackageDetailResponse {
	package: CatalogPackageSummary
	items: CatalogPackageItem[]
}

export interface CatalogItemInstallResponse {
	id: string
	item_type: CatalogItemType
	name: string
}

export interface CatalogItemInstalledEntry {
	catalog_item_id: string
	entity_id: string
	entity_type: 'actor' | 'trigger' | 'skill' | 'integration'
}

export interface CatalogItemsInstalledResponse {
	items: CatalogItemInstalledEntry[]
}

export interface InstalledPackageRow {
	id: string
	workspaceId: string
	sourcePackageId: string
	packageName: string
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	availableVersion: string
	hasUpdate: boolean
}

export interface InstalledPackagesListResponse {
	installs: InstalledPackageRow[]
}

interface InstalledPackageInstallResponse {
	id: string
	workspaceId: string
	sourcePackageId: string
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	provisioned: { actors: number; triggers: number; skills: number; integrations: number }
}

interface InstalledPackageForkResponse {
	id: string
	workspaceId: string
	sourcePackageId: string
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	detached: { actors: number; triggers: number; skills: number; integrations: number }
}
