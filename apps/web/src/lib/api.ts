import type {
	ActorListItem,
	ActorResponse,
	AgentState,
	DisplaySettingsBody,
	ListLoopsResponse,
	LoopSummary,
	SafeMetadata,
	TriggerResponse,
} from '@maskin/shared'

export type {
	ActorListItem,
	ActorResponse,
	AgentState,
	DisplaySettingsBody,
	ListLoopsResponse,
	LoopSummary,
	TriggerResponse,
}
import { getApiKey } from './auth'
import { API_BASE } from './constants'
import { reportApiFailure } from './faro'

export interface PlanCapContext {
	plan: string
	used: number
	cap: number
	period_end: number | null
}

export class ApiError extends Error {
	fieldErrors: Record<string, string[]>
	/** Structured error code from the backend's `{ error: { code, ... } }` body, e.g. `PLAN_CAP_EXCEEDED`. */
	code?: string
	/** Populated when `code === 'PLAN_CAP_EXCEEDED'` — the plan/used/cap/reset context for a typed upgrade CTA. */
	planCapContext?: PlanCapContext

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
	/** Send/receive cookies cross-origin. Only the OAuth connect call needs
	 *  this: the server sets an HttpOnly nonce cookie there, and the callback
	 *  requires it back to prove the same browser started the flow. */
	credentials?: RequestCredentials
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const { method = 'GET', body, headers = {}, workspaceId, credentials } = opts
	const apiKey = getApiKey()

	const reqHeaders: Record<string, string> = {
		// Marks this call as originating from the web UI so route-level
		// analytics (e.g. knowledge_object_created / _read) can attribute
		// `created_via` / `accessed_via` without inferring from actorType.
		// Overridable via `headers` for the (currently zero) callers that
		// need to spoof a different source.
		'X-Client-Source': 'ui',
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

	let res: Response
	try {
		res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: reqHeaders,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			...(credentials ? { credentials } : {}),
		})
	} catch (err) {
		// No status to report — offline, DNS, CORS or a dropped connection — but
		// the user still experienced a broken screen, so it belongs in Faro.
		reportApiFailure({ method, path, status: 0, code: 'NETWORK_ERROR' })
		throw err
	}

	if (!res.ok) {
		const data = await res.json().catch(() => ({ error: res.statusText }))

		let fieldErrors: Record<string, string[]> | undefined
		let message: string
		let code: string | undefined
		let planCapContext: PlanCapContext | undefined

		if (typeof data.error === 'object' && data.error?.code) {
			// Structured error format: { error: { code, message, details?, suggestion? } }
			message = data.error.message
			code = data.error.code
			if (data.error.details && Array.isArray(data.error.details)) {
				fieldErrors = {}
				for (const detail of data.error.details) {
					const field = detail.field || '_root'
					if (!fieldErrors[field]) fieldErrors[field] = []
					fieldErrors[field].push(detail.message)
				}
			}
			if (code === 'PLAN_CAP_EXCEEDED') {
				planCapContext = {
					plan: data.error.plan,
					used: data.error.used,
					cap: data.error.cap,
					period_end: data.error.period_end ?? null,
				}
			}
		} else if (typeof data.error === 'string') {
			// TODO: Remove legacy string format fallback once all API responses use structured errors
			message = data.error
		} else {
			message = data.error?.message || res.statusText
		}

		const err = new ApiError(res.status, message, fieldErrors)
		err.code = code
		err.planCapContext = planCapContext
		// This is the single chokepoint for every /api call the UI makes, so a
		// non-2xx here is where a backend problem becomes visible to a user.
		// Method, path (query stripped), status and the structured error code
		// only — never the response body or the message, which are free text.
		reportApiFailure({ method, path, status: res.status, code })
		throw err
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
		references: (id: string, workspaceId: string) =>
			request<KnowledgeReferencesResponse>(`/objects/${id}/references`, { workspaceId }),
		create: (workspaceId: string, data: CreateObjectInput) =>
			request<ObjectResponse>('/objects', { method: 'POST', body: data, workspaceId }),
		update: (id: string, data: UpdateObjectInput) =>
			request<ObjectResponse>(`/objects/${id}`, { method: 'PATCH', body: data }),
		verify: (id: string, verified: boolean) =>
			request<ObjectResponse>(`/objects/${id}/verification`, {
				method: 'POST',
				body: { verified },
			}),
		undoWrite: (id: string, eventId: number) =>
			request<ObjectResponse>(`/objects/${id}/undo-write`, {
				method: 'POST',
				body: { eventId },
			}),
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
		uploadAvatar: async (id: string, file: File, workspaceId: string): Promise<ActorResponse> => {
			const apiKey = getApiKey()
			const formData = new FormData()
			formData.append('file', file)
			const res = await fetch(`${API_BASE}/actors/${id}/avatar`, {
				method: 'POST',
				headers: {
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					'X-Workspace-Id': workspaceId,
				},
				body: formData,
			})
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: res.statusText }))
				const raw =
					typeof data.error === 'object' ? data.error.message : data.error || res.statusText
				// Turn raw status codes into human-readable messages when the server
				// returns bare 413/415 without a helpful body (per T6 DoD).
				let message: string = raw
				if (res.status === 413) {
					message = 'Image is too large. Maximum size is 2 MB.'
				} else if (res.status === 415) {
					message = 'Unsupported image type. Upload a PNG or JPG.'
				} else if (res.status === 403) {
					message = 'Only workspace admins can upload avatars.'
				}
				throw new ApiError(res.status, message)
			}
			return res.json()
		},
	},

	workspaces: {
		list: () => request<WorkspaceWithRole[]>('/workspaces'),
		create: (data: { name: string }) =>
			request<WorkspaceResponse>('/workspaces', { method: 'POST', body: data }),
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
			updateRole: (workspaceId: string, actorId: string, role: string) =>
				request<MemberResponse>(`/workspaces/${workspaceId}/members/${actorId}`, {
					method: 'PATCH',
					body: { role },
				}),
			remove: (workspaceId: string, actorId: string) =>
				request<{ removed: true }>(`/workspaces/${workspaceId}/members/${actorId}`, {
					method: 'DELETE',
				}),
		},
		transferOwnership: (workspaceId: string, newOwnerActorId: string) =>
			request<WorkspaceResponse>(`/workspaces/${workspaceId}/transfer-ownership`, {
				method: 'POST',
				body: { new_owner_actor_id: newOwnerActorId },
			}),
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

	loops: {
		list: (workspaceId: string) => request<ListLoopsResponse>('/loops', { workspaceId }),
		activity: (id: string, workspaceId: string) =>
			request<{ events: EventResponse[] }>(`/loops/${id}/activity`, { workspaceId }),
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
			request<{ install_url?: string; webhook_url?: string; integration_id?: string }>(
				`/integrations/${provider}/connect`,
				{
					method: 'POST',
					body,
					workspaceId,
					// The response carries the Set-Cookie that binds this browser to the
					// OAuth `state`; without `include` it is dropped and the callback 400s.
					credentials: 'include',
				},
			),
		complete: (id: string, workspaceId: string, secret: string) =>
			request<{ activated: boolean }>(`/integrations/${id}/complete`, {
				method: 'POST',
				body: { secret },
				workspaceId,
			}),
		disconnect: (id: string, workspaceId: string) =>
			request<{ deleted: boolean }>(`/integrations/${id}`, {
				method: 'DELETE',
				workspaceId,
			}),
		githubLinkable: (workspaceId: string) =>
			request<LinkableGithubInstallation[]>('/integrations/github/linkable', { workspaceId }),
		githubLink: (workspaceId: string, installationId: string) =>
			request<IntegrationResponse>('/integrations/github/link', {
				method: 'POST',
				body: { installation_id: installationId },
				workspaceId,
			}),
		githubPendingSelection: (workspaceId: string, integrationId: string) =>
			request<GithubPendingSelection>(`/integrations/github/pending-selection/${integrationId}`, {
				workspaceId,
			}),
		githubSelectInstallation: (
			workspaceId: string,
			integrationId: string,
			installationId: string,
		) =>
			request<IntegrationResponse>('/integrations/github/select-installation', {
				method: 'POST',
				body: { integration_id: integrationId, installation_id: installationId },
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
		pause: (id: string, workspaceId: string) =>
			request<SessionResponse>(`/sessions/${id}/pause`, { method: 'POST', workspaceId }),
		resume: (id: string, workspaceId: string) =>
			request<SessionResponse>(`/sessions/${id}/resume`, { method: 'POST', workspaceId }),
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
		rename: (workspaceId: string, slot: ClaudeOAuthSlot, nickname: string) =>
			request<{ success: boolean }>('/claude-oauth/nickname', {
				method: 'PATCH',
				body: { slot, nickname },
				workspaceId,
			}),
	},

	billing: {
		checkout: (workspaceId: string, body: BillingCheckoutInput) =>
			request<BillingCheckoutResponse>('/billing/checkout', {
				method: 'POST',
				body,
				workspaceId,
			}),
		buyCredits: (workspaceId: string, body: BillingBuyCreditsInput) =>
			request<BillingCheckoutResponse>('/billing/credits/checkout', {
				method: 'POST',
				body,
				workspaceId,
			}),
		usage: (workspaceId: string) =>
			request<BillingUsageResponse>('/billing/usage', { workspaceId }),
		cancel: (workspaceId: string) =>
			request<{ ok: true }>('/billing/cancel', { method: 'POST', workspaceId }),
	},

	marketplaceLoops: {
		list: (params?: { type?: string; use_case?: string; q?: string }) => {
			const qs = params
				? `?${new URLSearchParams(
						Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
					)}`
				: ''
			return request<MarketplaceLoopsListResponse>(`/marketplace/loops${qs}`)
		},
		get: (id: string) => request<MarketplaceLoopDetailResponse>(`/marketplace/loops/${id}`),
	},

	marketplaceItems: {
		install: (itemId: string, workspaceId: string) =>
			request<MarketplaceItemInstallResponse>(
				`/marketplace/items/${encodeURIComponent(itemId)}/install`,
				{
					method: 'POST',
					body: { workspaceId },
					workspaceId,
				},
			),
		installed: (workspaceId: string) =>
			request<MarketplaceItemsInstalledResponse>(
				`/marketplace/items/installed?workspaceId=${encodeURIComponent(workspaceId)}`,
				{ workspaceId },
			),
		uninstall: (itemId: string, workspaceId: string, keepProvisionedItems: boolean) =>
			request<{ deleted: boolean }>(`/marketplace/items/${encodeURIComponent(itemId)}/uninstall`, {
				method: 'DELETE',
				body: { workspaceId, keepProvisionedItems },
				workspaceId,
			}),
	},

	installedLoops: {
		list: (workspaceId: string) =>
			request<InstalledLoopsListResponse>(
				`/installed-loops?workspaceId=${encodeURIComponent(workspaceId)}`,
				{ workspaceId },
			),
		install: (workspaceId: string, loopId: string, source?: 'detail') =>
			request<InstalledLoopInstallResponse>('/installed-loops', {
				method: 'POST',
				body: { loopId, workspaceId, ...(source ? { source } : {}) },
				workspaceId,
			}),
		fork: (workspaceId: string, installedLoopId: string) =>
			request<InstalledLoopForkResponse>(`/installed-loops/${installedLoopId}/fork`, {
				method: 'POST',
				workspaceId,
			}),
		uninstall: (workspaceId: string, installedLoopId: string, keepProvisionedItems: boolean) =>
			request<{ deleted: boolean }>(`/installed-loops/${installedLoopId}`, {
				method: 'DELETE',
				body: { keepProvisionedItems },
				workspaceId,
			}),
	},

	briefing: {
		get: (workspaceId: string) => request<BriefingResponse>('/briefing', { workspaceId }),
		/** POST because it generates — one model call, only when asked for. */
		spoken: (workspaceId: string) =>
			request<SpokenBriefResponse>('/briefing/spoken', { method: 'POST', workspaceId }),
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
		markUnread: (workspaceId: string, entityType: string, entityId: string) =>
			request<{ updated: true }>('/subscriptions/unread', {
				method: 'POST',
				body: { entity_type: entityType, entity_id: entityId },
				workspaceId,
			}),
		unread: (workspaceId: string, entityType?: string, includeRecentlyRead?: boolean) => {
			const params = new URLSearchParams()
			if (entityType) params.set('entity_type', entityType)
			if (includeRecentlyRead) params.set('include_recently_read', 'true')
			const qs = params.toString()
			return request<UnreadResponse>(qs ? `/subscriptions/unread?${qs}` : '/subscriptions/unread', {
				workspaceId,
			})
		},
	},

	featureFlags: {
		// Per-actor, not per-workspace — no workspaceId. The backend resolves the
		// booleans; the tester actor id list never reaches the browser.
		get: () => request<{ flags: Record<string, boolean> }>('/feature-flags'),
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
		upload: async (
			workspaceId: string,
			file: File,
			opts?: { skillId?: string },
		): Promise<WorkspaceSkillUploadResult> => {
			const apiKey = getApiKey()
			const formData = new FormData()
			formData.append('file', file)
			const qs = opts?.skillId ? `?skillId=${encodeURIComponent(opts.skillId)}` : ''
			const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/skills/upload${qs}`, {
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
		listFiles: (workspaceId: string, skillId: string) =>
			request<WorkspaceSkillFileEntry[]>(`/workspaces/${workspaceId}/skills/${skillId}/files`, {
				workspaceId,
			}),
		download: async (
			workspaceId: string,
			skillId: string,
		): Promise<{ blob: Blob; filename: string }> => {
			const apiKey = getApiKey()
			const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/skills/${skillId}/download`, {
				headers: {
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					'X-Workspace-Id': workspaceId,
				},
			})
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: res.statusText }))
				const message =
					typeof data.error === 'object' ? data.error.message : data.error || res.statusText
				throw new ApiError(res.status, message)
			}
			const disposition = res.headers.get('content-disposition') ?? ''
			// Prefer the RFC 5987 filename* parameter (UTF-8) over the ASCII fallback
			// so non-ASCII skill names round-trip cleanly.
			const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
			const ascii = /filename="([^"]+)"/.exec(disposition)?.[1]
			const filename = (utf8 ? decodeURIComponent(utf8) : ascii) ?? `${skillId}.zip`
			return { blob: await res.blob(), filename }
		},
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

	conversations: {
		list: (workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<ConversationListResponse>(`/conversations${qs}`, { workspaceId })
		},
		get: (id: string, workspaceId: string) =>
			request<ConversationDetailResponse>(`/conversations/${id}`, { workspaceId }),
		create: (workspaceId: string, data: CreateConversationInput) =>
			request<ConversationDetailResponse>('/conversations', {
				method: 'POST',
				body: data,
				workspaceId,
			}),
		update: (id: string, workspaceId: string, data: UpdateConversationInput) =>
			request<ConversationDetailResponse>(`/conversations/${id}`, {
				method: 'PATCH',
				body: data,
				workspaceId,
			}),
		addParticipants: (id: string, workspaceId: string, actorIds: string[]) =>
			request<ConversationParticipantResponse[]>(`/conversations/${id}/participants`, {
				method: 'POST',
				body: { actor_ids: actorIds },
				workspaceId,
			}),
		removeParticipant: (id: string, actorId: string, workspaceId: string) =>
			request<void>(`/conversations/${id}/participants/${actorId}`, {
				method: 'DELETE',
				workspaceId,
			}),
		messages: (id: string, workspaceId: string, params?: Record<string, string>) => {
			const qs = params ? `?${new URLSearchParams(params)}` : ''
			return request<MessagesListResponse>(`/conversations/${id}/messages${qs}`, { workspaceId })
		},
		postMessage: (id: string, workspaceId: string, data: PostMessageInput) =>
			request<MessageResponse>(`/conversations/${id}/messages`, {
				method: 'POST',
				body: data,
				workspaceId,
			}),
		editMessage: (id: string, workspaceId: string, messageId: number, data: EditMessageInput) =>
			request<MessageResponse>(`/conversations/${id}/messages/${messageId}`, {
				method: 'PATCH',
				body: data,
				workspaceId,
			}),
		// agentId scopes the retry to one agent ("Redo this response"); omitted,
		// every participant re-evaluates ("Ask agents to respond again").
		retryMessage: (id: string, workspaceId: string, messageId: number, agentId?: string) =>
			request<{ retried: boolean }>(
				`/conversations/${id}/messages/${messageId}/retry${agentId ? `?agent_id=${agentId}` : ''}`,
				{
					method: 'POST',
					workspaceId,
				},
			),
		updateMe: (id: string, workspaceId: string, data: UpdateConversationParticipantStateInput) =>
			request<ConversationParticipantStateResponse>(`/conversations/${id}/me`, {
				method: 'PATCH',
				body: data,
				workspaceId,
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
	fingerprint?: string
	nickname?: string
}

export interface ClaudeOAuthExchangeResponse {
	success: boolean
	slot?: ClaudeOAuthSlot
	subscription_type?: string
	expires_at: number
	nickname?: string
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
	last_backup_failure_at?: number
	last_backup_classified_reason?: string
}

export interface ClaudeOAuthImportInput {
	accessToken: string
	refreshToken: string
	expiresAt: number
	subscriptionType?: string
	scopes?: string[]
	slot?: ClaudeOAuthSlot
	nickname?: string
}

export type BillingPlan = 'trial' | 'pro' | 'team' | 'enterprise'
export type BillingStatus = 'active' | 'past_due' | 'canceled' | 'incomplete'

export interface BillingCheckoutInput {
	plan: 'pro' | 'team'
	success_url: string
	cancel_url: string
}

export interface BillingCheckoutResponse {
	url: string
	session_id: string
}

export interface BillingBuyCreditsInput {
	amount_usd_cents: number
	success_url: string
	cancel_url: string
}

export interface LinkedInIdentityAddonLine {
	count: number
	unit_price_usd_cents: number
	monthly_total_usd_cents: number
}

export interface BillingUsageResponse {
	plan: BillingPlan
	status: BillingStatus
	// Actual dollar cost incurred this period, in USD cents — see
	// apps/dev/src/routes/billing.ts.
	usd_cents_used: number
	hard_cap_usd_cents: number | null
	period_start: number | null
	period_resets_in_ms: number | null
	stripe_customer_id: string | null
	stripe_subscription_id: string | null
	credit_balance_cents: number
	// $49/connected LinkedIn identity/month, shown as its own SKU on the plan
	// surface — see apps/dev/src/lib/linkedin-addon.ts. Null when the caller's
	// `linkedin-addon-visible` flag is off OR the workspace has no connected
	// linkedin-unipile credentials. Deliberately separate from
	// `credit_balance_cents` and `usd_cents_used`: connectivity and inference
	// are billed as distinct lines.
	linkedin_identity_addon: LinkedInIdentityAddonLine | null
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
	// Count of unread events on the entity that actually @-mention the viewer.
	// Not rendered: the feed is mentions-only, so this equals unread_count on
	// every card except an onboarding_session, and a "Mentioned" pill would sit
	// on nearly all of them. The card shows the mention itself instead.
	mentioning_unread_count: number
	// Highest attention score (1-5) among the entity's unread comments. null
	// when no unread comment carries a score — sorts below scored comments in
	// the Priority sort.
	max_unread_attention: number | null
	latest_event_id: number | null
	latest_activity_at: string | null
	object?: ObjectResponse
	// The comment that put this item in the feed. Absent only for entities with
	// no joined event payload (a subscription whose events were pruned).
	latest_mention?: LatestMention
}

export interface LatestMentionDecisionOption {
	label: string
	consequences: string[]
	recommended?: boolean
}

export interface LatestMentionDecision {
	title: string
	summary: string
	ask: string
	options: LatestMentionDecisionOption[]
}

export interface LatestMention {
	event_id: number
	actor_id: string | null
	created_at: string
	// The whole comment body, not a preview.
	content: string
	attention: number | null
	// Present only when the agent asked for a structured decision. The card
	// renders its options as the buttons the reader taps.
	decision: LatestMentionDecision | null
}

export interface UnreadResponse {
	items: UnreadItem[]
}

export interface BriefingResponse {
	workspace_id: string
	markdown: string
}

/**
 * The human-facing brief. `script` is spoken prose written by the workspace's
 * default agent — no markdown, no ids, nothing for the client to strip.
 */
export interface SpokenBriefResponse {
	workspace_id: string
	headline: string
	script: string
	mentioned_ids: string[]
	generated_at: string
	/** Who wrote it. `agent` only when the model actually produced the script. */
	source: 'agent' | 'fallback'
	/** Served from the day's cache rather than written just now — orthogonal to
	 *  `source`, since a cached brief still has an author. */
	cached: boolean
	/** Null whenever `source` is `fallback`, so the UI cannot credit an agent
	 *  that didn't write the prose. */
	agent: { id: string; name: string } | null
	model: string | null
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
	enterprise: boolean
	// Single accountable human payer for this workspace's plan — read-only,
	// server-set. See apps/dev/src/lib/workspace-capacity.ts.
	billingOwnerId: string | null
	createdBy: string | null
	createdAt: string | null
	updatedAt: string | null
}

export interface WorkspaceWithRole extends WorkspaceResponse {
	role: string
	/** People in the workspace, including the caller — the workspace menu's sub-line. */
	memberCount: number
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

export interface KnowledgeReferencesResponse {
	window_days: number
	unique_contexts: number
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
	/** Scopes this install's token lacks that the provider now requires. Names only. */
	missingScopes?: string[]
	/** True when `missingScopes` is non-empty — reconnecting re-consents and fixes it. */
	needsReconnect?: boolean
}

/** A GitHub App installation the current actor can bind to this workspace,
 *  because they already reach it from one of their workspaces. */
/** Installations a GitHub user proved they can reach, awaiting their choice.
 *  Parked on a `pending` integration row by the connect callback when the user
 *  can access more than one — see POST /integrations/github/select-installation. */
export interface GithubPendingSelection {
	integrationId: string
	installations: Array<{ installationId: string; ownerLogin: string | null }>
}

export interface LinkableGithubInstallation {
	installationId: string
	ownerLogin: string | null
	alreadyLinked: boolean
}

export interface ProviderEventDefinition {
	entityType: string
	actions: string[]
	label: string
}

export interface ProviderInfo {
	name: string
	displayName: string
	authType: 'oauth2' | 'oauth2_custom' | 'api_key' | 'manual'
	events: ProviderEventDefinition[]
	externalIdDisplay?: 'email' | 'installation'
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
	// Optional so a row from a backend that hasn't shipped T2 yet still types — falsy
	// values fall through to the single-file render path.
	isFolder?: boolean
	fileCount?: number | null
	createdBy: string | null
	createdAt: string
	updatedAt: string
}

export interface WorkspaceSkillDetail extends WorkspaceSkillListItem {
	content: string
}

export interface WorkspaceSkillUploadResult extends WorkspaceSkillDetail {
	error: { kind: string; message: string } | null
}

export interface WorkspaceSkillFileEntry {
	relativePath: string
	sizeBytes: number
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

// Conversation entity fields are camelCase (Drizzle column names passed
// through `serialize()`, which only stringifies Dates — it does not
// snake_case). Only per-viewer computed fields (pinned, archived,
// unread_count, snippet, last_read_message_id) are literal keys added by the
// route handler, and those happen to already read as snake_case/plain words.
// See apps/dev/src/lib/openapi-schemas.ts (conversation*ResponseSchema).
export interface ConversationParticipantResponse {
	actorId: string
	actorName: string
	actorType: 'human' | 'agent'
	joinedAt: string | null
	addedBy: string | null
}

export interface ConversationListItemResponse {
	id: string
	workspaceId: string
	title: string
	createdBy: string
	lastMessageAt: string | null
	createdAt: string | null
	updatedAt: string | null
	pinned: boolean
	archived: boolean
	unread_count: number
	snippet: string | null
	/** Who wrote `snippet` — the list row prefixes the preview with their name. */
	snippet_actor_id: string | null
	snippet_actor_name: string | null
	participants: ConversationParticipantResponse[]
}

export interface ConversationListResponse {
	conversations: ConversationListItemResponse[]
	has_more: boolean
}

export interface ConversationDetailResponse {
	id: string
	workspaceId: string
	title: string
	createdBy: string
	lastMessageAt: string | null
	createdAt: string | null
	updatedAt: string | null
	pinned: boolean
	archived: boolean
	last_read_message_id: number | null
	participants: ConversationParticipantResponse[]
}

export interface ConversationParticipantStateResponse {
	pinned: boolean
	archived: boolean
	last_read_message_id: number | null
}

export interface MessageAttachment {
	file_id: string
	name?: string
	mime_type?: string
	size_bytes?: number
}

export interface MessageContextObject {
	id: string
	title?: string
	type?: string
}

export interface MessageContextNotification {
	id: string
	title?: string
}

export interface MessageFinalOutput {
	dedupe_key: string
	/** The chat message whose turn produced this output, when resolvable. */
	message_id?: number | null
	is_error?: boolean
	subtype?: string
	truncated?: boolean
	/** Reply was recovered from the turn's log because `result` came back blank. */
	recovered?: boolean
	/**
	 * How a failed turn was read: 'transient' means the model API blipped and
	 * the turn was replayed, 'permanent' means no replay would have helped.
	 * Mirrors messageFinalOutputSchema in packages/shared.
	 */
	error_kind?: 'transient' | 'permanent'
	/** Replays spent before giving up on a transient failure. */
	retries?: number
	/**
	 * Why a transient failure was reported instead of replayed. 'unanswered' is
	 * the one kind with no `result` envelope behind it — see
	 * finalOutputsFromSession in use-conversation-activity.ts.
	 */
	retry?: 'unavailable' | 'undeliverable' | 'unanswered'
}

export interface MessageQuestionOption {
	label: string
	description?: string
}

export interface MessageQuestionItem {
	question: string
	header: string
	multi_select: boolean
	options: MessageQuestionOption[]
}

/** An agent's AskUserQuestion, surfaced into chat as selectable options. */
export interface MessageQuestion {
	session_id: string
	questions: MessageQuestionItem[]
}

/** Which options the human picked, posted back on their reply message. */
export interface MessageQuestionAnswer {
	question_message_id: number
	answers: Array<{ header: string; selected: string[] }>
}

export interface MessageMetadata {
	attachments?: MessageAttachment[]
	mentions?: string[]
	context_objects?: MessageContextObject[]
	context_notifications?: MessageContextNotification[]
	/**
	 * Backend-owned; stripped from anything a client sends. 'final_output'
	 * marks an agent's automatically-posted end-of-turn reply, as opposed to
	 * one it posted mid-turn via the post_conversation_message MCP tool.
	 */
	source?: 'final_output'
	final_output?: MessageFinalOutput
	/**
	 * Backend-owned; stripped from anything a client sends, so a forged message
	 * cannot put an official-looking prompt in an agent's mouth.
	 */
	question?: MessageQuestion
	/** Client-supplied: pairs a human's reply back to the question it answers. */
	question_answer?: MessageQuestionAnswer
}

export interface MessageResponse {
	id: number
	conversationId: string
	actorId: string
	actorName: string
	actorType: 'human' | 'agent'
	kind: 'message' | 'system'
	content: string
	metadata: MessageMetadata | null
	sessionId: string | null
	createdAt: string | null
	editedAt: string | null
}

export interface EditMessageInput {
	content: string
}

export interface MessagesListResponse {
	messages: MessageResponse[]
	has_more: boolean
}

export interface CreateConversationInput {
	title: string
	participant_actor_ids: string[]
	initial_message?: string
	initial_message_metadata?: MessageMetadata
}

export interface UpdateConversationInput {
	title: string
}

export interface UpdateConversationParticipantStateInput {
	pinned?: boolean
	archived?: boolean
	last_read_message_id?: number
}

export interface PostMessageInput {
	content: string
	metadata?: MessageMetadata
	session_id?: string
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
	entry_agent_role?: string
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
	name?: string
	mime_type?: string
	size_bytes?: number
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
	/** Structured extras the backend already accepts on `POST /events`
	 *  (`createCommentSchema.metadata`, a `safeMetadataSchema` record). The UI
	 *  writes `{ refs: string[] }` from "Reference an object". Options for the
	 *  reader to pick from do not live here — that is `decision`. */
	metadata?: Record<string, unknown>
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

export type MarketplaceItemType = 'actor' | 'trigger' | 'skill' | 'integration'

export interface MarketplaceLoopSummary {
	id: string
	name: string
	slug: string
	description: string
	version: string
	use_case: string | null
	item_types: MarketplaceItemType[]
	created_at: string | null
	updated_at: string | null
}

export interface MarketplaceLoopItem {
	id: string
	loop_id: string
	item_type: MarketplaceItemType
	source_item_id: string
	item_snapshot: Record<string, unknown>
	created_at: string | null
}

export interface MarketplaceLoopCounts {
	total: number
	by_type: Record<MarketplaceItemType, number>
	by_use_case: Record<string, number>
}

export interface MarketplaceLoopsListResponse {
	loops: MarketplaceLoopSummary[]
	counts: MarketplaceLoopCounts
}

export interface MarketplaceLoopDetailResponse {
	loop: MarketplaceLoopSummary
	items: MarketplaceLoopItem[]
}

export interface MarketplaceItemInstallResponse {
	id: string
	item_type: MarketplaceItemType
	name: string
}

export interface MarketplaceItemInstalledEntry {
	marketplace_item_id: string
	entity_id: string
	entity_type: 'actor' | 'trigger' | 'skill' | 'integration'
}

export interface MarketplaceItemsInstalledResponse {
	items: MarketplaceItemInstalledEntry[]
}

export interface InstalledLoopRow {
	id: string
	workspaceId: string
	sourceLoopId: string
	objectId: string | null
	loopName: string
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	availableVersion: string
	hasUpdate: boolean
}

export interface InstalledLoopsListResponse {
	installs: InstalledLoopRow[]
}

interface InstalledLoopInstallResponse {
	id: string
	workspaceId: string
	sourceLoopId: string
	objectId: string | null
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	provisioned: { actors: number; triggers: number; skills: number; integrations: number }
}

interface InstalledLoopForkResponse {
	id: string
	workspaceId: string
	sourceLoopId: string
	objectId: string | null
	installedVersion: string
	isLocked: boolean
	forkedAt: string | null
	installedAt: string | null
	updatedAt: string | null
	detached: { actors: number; triggers: number; skills: number; integrations: number }
}
