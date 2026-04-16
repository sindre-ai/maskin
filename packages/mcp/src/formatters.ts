/**
 * Human-readable formatters for MCP tool responses.
 *
 * Each formatter converts raw API response data into structured text
 * that AI assistants can present directly to users.
 */

// ─── Helpers ─────────────────────────────────────────────

export function timeAgo(dateStr: string | undefined | null): string {
	if (!dateStr) return ''
	const now = Date.now()
	const then = new Date(dateStr).getTime()
	if (Number.isNaN(then)) return ''
	const diffMs = now - then
	const seconds = Math.floor(diffMs / 1000)
	if (seconds < 60) return 'just now'
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d ago`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo ago`
	const years = Math.floor(months / 12)
	return `${years}y ago`
}

export function truncate(text: string | undefined | null, maxLen = 200): string {
	if (!text) return ''
	const oneLine = text.replace(/\n+/g, ' ').trim()
	if (oneLine.length <= maxLen) return oneLine
	return `${oneLine.slice(0, maxLen)}...`
}

function pad(str: string, len: number): string {
	return str.length >= len ? str : str + ' '.repeat(len - str.length)
}

const CRON_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function describeCron(expression: string): string {
	const parts = expression.trim().split(/\s+/)
	if (parts.length !== 5) return expression

	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
		string,
		string,
		string,
		string,
		string,
	]

	// Every N minutes: */N * * * *
	if (
		minute.startsWith('*/') &&
		hour === '*' &&
		dayOfMonth === '*' &&
		month === '*' &&
		dayOfWeek === '*'
	) {
		const n = minute.slice(2)
		return `every ${n} min`
	}

	// Fixed minute + hour patterns
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
		const h = hour.padStart(2, '0')
		const m = minute.padStart(2, '0')
		const time = `${h}:${m}`

		// Daily: 0 H * * *
		if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
			return `daily at ${time}`
		}

		// Weekdays: 0 H * * 1-5
		if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
			return `weekdays at ${time}`
		}

		// Weekly on a specific day: 0 H * * N
		if (dayOfMonth === '*' && month === '*' && /^\d$/.test(dayOfWeek)) {
			const dayIdx = Number.parseInt(dayOfWeek, 10) % 7
			return `weekly on ${CRON_DAY_NAMES[dayIdx]} at ${time}`
		}

		// Monthly: 0 H D * *
		if (/^\d+$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
			const d = Number.parseInt(dayOfMonth, 10)
			const suffix = d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'
			return `monthly on the ${d}${suffix} at ${time}`
		}
	}

	return expression
}

// ─── Objects ─────────────────────────────────────────────

interface ObjectData {
	id?: string
	type?: string
	title?: string
	content?: string
	status?: string
	metadata?: Record<string, unknown>
	createdAt?: string
	updatedAt?: string
	created_at?: string
	updated_at?: string
	ownerId?: string
	owner_id?: string
}

interface GraphResult {
	object?: ObjectData
	relationships?: Array<{
		id?: string
		type?: string
		sourceId?: string
		targetId?: string
		source_id?: string
		target_id?: string
	}>
	connected?: ObjectData[]
}

export function formatObject(obj: ObjectData): string {
	const created = obj.createdAt ?? obj.created_at
	const updated = obj.updatedAt ?? obj.updated_at
	const lines: string[] = []

	lines.push(`📄 ${obj.title || 'Untitled'}`)
	lines.push('')
	lines.push(`  Type:    ${obj.type ?? 'unknown'}`)
	lines.push(`  Status:  ${obj.status ?? 'unknown'}`)
	if (obj.id) lines.push(`  ID:      ${obj.id}`)
	const owner = obj.ownerId ?? obj.owner_id
	if (owner) lines.push(`  Owner:   ${owner}`)
	if (created) lines.push(`  Created: ${timeAgo(created)}`)
	if (updated) lines.push(`  Updated: ${timeAgo(updated)}`)

	if (obj.content) {
		lines.push('')
		lines.push('  Content:')
		lines.push(`  ${truncate(obj.content, 300)}`)
	}

	if (obj.metadata && Object.keys(obj.metadata).length > 0) {
		lines.push('')
		lines.push('  Metadata:')
		for (const [key, value] of Object.entries(obj.metadata)) {
			lines.push(`    ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
		}
	}

	return lines.join('\n')
}

export function formatObjectGraph(graph: GraphResult): string {
	if (!graph.object) return '(no object data)'
	const lines: string[] = [formatObject(graph.object)]
	const rels = graph.relationships ?? []
	const connected = graph.connected ?? []

	if (rels.length > 0) {
		lines.push('')
		lines.push(`  Relationships (${rels.length}):`)
		for (const rel of rels) {
			const sourceId = rel.sourceId ?? rel.source_id
			const targetId = rel.targetId ?? rel.target_id
			const isOutbound = sourceId === graph.object.id
			const connectedId = isOutbound ? targetId : sourceId
			const connectedObj = connected.find((c) => c.id === connectedId)
			const arrow = isOutbound ? '→' : '←'
			const label = connectedObj
				? `${connectedObj.title || 'Untitled'} (${connectedObj.type}, ${connectedObj.status})`
				: (connectedId ?? 'unknown')
			lines.push(`    ${arrow} ${rel.type}: ${label}`)
		}
	}

	return lines.join('\n')
}

export function formatObjectList(
	objects: ObjectData[],
	opts?: { query?: string; offset?: number; total?: number },
): string {
	if (!objects.length) {
		return opts?.query
			? `📋 No objects matching "${opts.query}". Try broader terms or use list_objects to browse.`
			: '📋 No objects found. Use create_objects to add insights, bets, or tasks.'
	}

	const lines: string[] = []
	const label = opts?.query ? `Search results for "${opts.query}"` : 'Objects'
	lines.push(`📋 ${label} (${opts?.total ?? objects.length} results)`)
	lines.push('')

	// Compute column widths
	const typeWidth = Math.max(...objects.map((o) => (o.type ?? '').length), 4)
	const statusWidth = Math.max(...objects.map((o) => (o.status ?? '').length), 6)

	for (const obj of objects) {
		const created = obj.createdAt ?? obj.created_at
		const idPrefix = obj.id ? `${obj.id.slice(0, 8)} | ` : ''
		const type = pad(obj.type ?? '', typeWidth)
		const status = pad(obj.status ?? '', statusWidth)
		const title = truncate(obj.title, 40)
		const ago = timeAgo(created)
		lines.push(`  ${idPrefix}${type} | ${status} | ${title}${ago ? ` | ${ago}` : ''}`)
	}

	if (opts?.offset != null && opts.total != null) {
		const start = opts.offset + 1
		const end = opts.offset + objects.length
		lines.push('')
		lines.push(`Showing ${start}–${end} of ${opts.total}. Use offset/limit for pagination.`)
	}

	return lines.join('\n')
}

// ─── Events ──────────────────────────────────────────────

interface EventData {
	id?: string
	action?: string
	entityType?: string
	entity_type?: string
	entityId?: string
	entity_id?: string
	actorId?: string
	actor_id?: string
	actorName?: string
	actor_name?: string
	metadata?: Record<string, unknown>
	createdAt?: string
	created_at?: string
}

export function formatEvent(event: EventData): string {
	const actor = event.actorName ?? event.actor_name ?? event.actorId ?? event.actor_id ?? 'Unknown'
	const action = event.action ?? 'did something'
	const entityType = event.entityType ?? event.entity_type ?? ''
	const entityId = event.entityId ?? event.entity_id ?? ''
	const created = event.createdAt ?? event.created_at
	const ago = timeAgo(created)
	const title =
		event.metadata && typeof event.metadata === 'object'
			? (event.metadata as Record<string, unknown>).title
			: undefined
	const target = title
		? `"${title}"`
		: entityId
			? `${entityType} ${entityId.slice(0, 8)}`
			: entityType
	return `• ${actor} ${action} ${target}${ago ? ` (${ago})` : ''}`
}

export function formatEventList(events: EventData[]): string {
	if (!events.length) return '⚡ No recent activity.'
	const lines: string[] = [`⚡ Recent Activity (${events.length} events)`, '']
	for (const event of events) {
		lines.push(`  ${formatEvent(event)}`)
	}
	return lines.join('\n')
}

// ─── Actors ──────────────────────────────────────────────

interface ActorData {
	id?: string
	name?: string
	type?: string
	email?: string
	role?: string
	api_key?: string
	system_prompt?: string
	tools?: Record<string, unknown>
	llm_provider?: string
	createdAt?: string
	created_at?: string
}

export function formatActor(actor: ActorData): string {
	const lines: string[] = []
	lines.push(`👤 ${actor.name || 'Unnamed'}`)
	lines.push('')
	lines.push(`  Type:  ${actor.type ?? 'unknown'}`)
	if (actor.role) lines.push(`  Role:  ${actor.role}`)
	if (actor.email) lines.push(`  Email: ${actor.email}`)
	if (actor.id) lines.push(`  ID:    ${actor.id}`)
	const created = actor.createdAt ?? actor.created_at
	if (created) lines.push(`  Joined: ${timeAgo(created)}`)

	if (actor.type === 'agent') {
		if (actor.system_prompt) lines.push(`  Prompt: ${truncate(actor.system_prompt, 100)}`)
		if (actor.tools && Object.keys(actor.tools).length > 0) {
			lines.push(`  Tools:  ${Object.keys(actor.tools).join(', ')}`)
		}
		if (actor.llm_provider) lines.push(`  LLM:   ${actor.llm_provider}`)
	}

	if (actor.api_key) {
		lines.push('')
		lines.push(`  ⚠ API key (save now — shown only once): ${actor.api_key}`)
	}

	return lines.join('\n')
}

export function formatActorList(actors: ActorData[]): string {
	if (!actors.length) return '👥 No team members found. Use create_actor to add humans or agents.'
	const lines: string[] = [`👥 Team (${actors.length} member${actors.length === 1 ? '' : 's'})`, '']
	for (const actor of actors) {
		const role = actor.role ? ` (${actor.role})` : ''
		const id = actor.id ? `  id: ${actor.id}` : ''
		lines.push(`  • ${actor.name || 'Unnamed'} — ${actor.type ?? 'unknown'}${role}${id}`)
	}
	return lines.join('\n')
}

// ─── Sessions ────────────────────────────────────────────

interface SessionData {
	id?: string
	status?: string
	actorId?: string
	actor_id?: string
	actorName?: string
	actor_name?: string
	actionPrompt?: string
	action_prompt?: string
	createdAt?: string
	created_at?: string
	updatedAt?: string
	updated_at?: string
	config?: Record<string, unknown>
}

interface SessionLogEntry {
	message?: string
	stream?: string
	timestamp?: string
	created_at?: string
}

export function formatSession(session: SessionData, logs?: SessionLogEntry[]): string {
	const lines: string[] = []
	const status = session.status ?? 'unknown'
	const prompt = session.actionPrompt ?? session.action_prompt
	const created = session.createdAt ?? session.created_at
	const updated = session.updatedAt ?? session.updated_at

	const statusIcon =
		status === 'completed' ? ' ✓' : status === 'failed' ? ' ✗' : status === 'timeout' ? ' ⏱' : ''
	lines.push(`🤖 Session — ${status}${statusIcon}`)
	lines.push('')
	if (session.id) lines.push(`  ID:      ${session.id}`)
	lines.push(`  Status:  ${status}`)
	const actor = session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id
	if (actor) lines.push(`  Actor:   ${actor}`)
	if (prompt) lines.push(`  Prompt:  ${truncate(prompt, 100)}`)
	if (created) lines.push(`  Started: ${timeAgo(created)}`)

	// Elapsed time for terminal sessions
	if (created && updated) {
		const startMs = new Date(created).getTime()
		const endMs = new Date(updated).getTime()
		if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
			const sec = Math.floor((endMs - startMs) / 1000)
			const elapsed = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`
			lines.push(`  Elapsed: ${elapsed}`)
		}
	}

	// Container config
	if (session.config) {
		const cfg = session.config
		const parts: string[] = []
		if (cfg.runtime) parts.push(`runtime: ${cfg.runtime}`)
		if (cfg.timeout_seconds) parts.push(`timeout: ${cfg.timeout_seconds}s`)
		if (cfg.memory_mb) parts.push(`memory: ${cfg.memory_mb}MB`)
		if (parts.length > 0) lines.push(`  Config:  ${parts.join(', ')}`)
	}

	if (logs && logs.length > 0) {
		lines.push('')
		lines.push(`  Logs (last ${Math.min(logs.length, 20)}):`)
		const recent = logs.slice(-20)
		for (const log of recent) {
			const prefix = log.stream === 'stderr' ? '  ⚠ ' : '  > '
			lines.push(`${prefix}${truncate(log.message, 120)}`)
		}
		if (logs.length > 20) {
			lines.push(`  ... and ${logs.length - 20} more log entries`)
		}
	}

	return lines.join('\n')
}

export function formatSessionList(sessions: SessionData[]): string {
	if (!sessions.length)
		return '🤖 No sessions found. Use create_session or run_agent to start an agent.'
	const lines: string[] = [`🤖 Sessions (${sessions.length})`, '']

	const statusWidth = Math.max(...sessions.map((s) => (s.status ?? '').length), 6)

	for (const session of sessions) {
		const idPrefix = session.id ? `${session.id.slice(0, 8)} | ` : ''
		const status = pad(session.status ?? '', statusWidth)
		const actor =
			session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id ?? ''
		const prompt = truncate(session.actionPrompt ?? session.action_prompt, 80)
		const created = session.createdAt ?? session.created_at
		const ago = timeAgo(created)
		lines.push(
			`  ${idPrefix}${status} | ${actor ? `${truncate(actor, 20)} | ` : ''}${prompt}${ago ? ` | ${ago}` : ''}`,
		)
	}

	return lines.join('\n')
}

// ─── Triggers ────────────────────────────────────────────

interface TriggerData {
	id?: string
	name?: string
	type?: string
	config?: Record<string, unknown>
	actionPrompt?: string
	action_prompt?: string
	targetActorId?: string
	target_actor_id?: string
	enabled?: boolean
	createdAt?: string
	created_at?: string
}

export function formatTrigger(trigger: TriggerData): string {
	const lines: string[] = []
	const enabled = trigger.enabled !== false ? '✓ enabled' : '✗ disabled'
	lines.push(`⚙️ ${trigger.name || 'Unnamed trigger'} (${enabled})`)
	lines.push('')
	lines.push(`  Type: ${trigger.type ?? 'unknown'}`)
	if (trigger.id) lines.push(`  ID:   ${trigger.id}`)

	if (trigger.config) {
		if (trigger.type === 'cron' && trigger.config.expression) {
			const raw = trigger.config.expression as string
			const desc = describeCron(raw)
			lines.push(`  Schedule: ${desc !== raw ? `${desc} (${raw})` : raw}`)
		} else if (trigger.type === 'event') {
			const entityType = trigger.config.entity_type ?? trigger.config.entityType ?? ''
			const action = trigger.config.action ?? ''
			lines.push(`  Fires on: ${entityType} ${action}`)
			const filter = trigger.config.filter
			if (filter && typeof filter === 'object' && Object.keys(filter as object).length > 0) {
				const parts = Object.entries(filter as Record<string, unknown>).map(
					([k, v]) => `${k} = ${v}`,
				)
				lines.push(`  Filter: ${parts.join(', ')}`)
			}
		}
	}

	const prompt = trigger.actionPrompt ?? trigger.action_prompt
	if (prompt) lines.push(`  Prompt: ${truncate(prompt, 100)}`)
	const actor = trigger.targetActorId ?? trigger.target_actor_id
	if (actor) lines.push(`  Target actor: ${actor}`)

	return lines.join('\n')
}

export function formatTriggerList(triggers: TriggerData[]): string {
	if (!triggers.length)
		return '⚙️ No triggers configured. Use create_trigger to set up cron or event automation.'
	const lines: string[] = [`⚙️ Triggers (${triggers.length})`, '']

	for (const trigger of triggers) {
		const enabled = trigger.enabled !== false ? '✓' : '✗'
		const type = trigger.type ?? ''
		let typeDetail = type
		if (type === 'cron' && trigger.config?.expression) {
			typeDetail = `cron (${describeCron(trigger.config.expression as string)})`
		} else if (type === 'event' && trigger.config) {
			const entityType = (trigger.config.entity_type ?? trigger.config.entityType ?? '') as string
			const action = (trigger.config.action ?? '') as string
			typeDetail = `event${entityType || action ? ` (${[entityType, action].filter(Boolean).join(' ')})` : ''}`
		}
		const disabledTag = trigger.enabled === false ? ' — disabled' : ''
		lines.push(`  ${enabled} ${trigger.name || 'Unnamed'} — ${typeDetail}${disabledTag}`)

		const details: string[] = []
		if (trigger.id) details.push(`ID: ${trigger.id}`)
		const actor = trigger.targetActorId ?? trigger.target_actor_id
		if (actor) details.push(`Target: ${actor}`)
		if (details.length) lines.push(`    ${details.join('  ')}`)

		const prompt = trigger.actionPrompt ?? trigger.action_prompt
		if (prompt) lines.push(`    Prompt: "${truncate(prompt, 60)}"`)

		lines.push('')
	}

	return lines.join('\n').trimEnd()
}

// ─── Notifications ───────────────────────────────────────

interface NotificationData {
	id?: string
	type?: string
	title?: string
	content?: string
	status?: string
	metadata?: Record<string, unknown>
	createdAt?: string
	created_at?: string
}

const NOTIFICATION_ICONS: Record<string, string> = {
	needs_input: '❓',
	recommendation: '💡',
	good_news: '🎉',
	alert: '🚨',
}

export function formatNotification(notif: NotificationData): string {
	const icon = NOTIFICATION_ICONS[notif.type ?? ''] ?? '📢'
	const lines: string[] = []
	lines.push(`${icon} ${notif.title || 'Untitled notification'}`)
	lines.push('')
	lines.push(`  Type:   ${notif.type ?? 'unknown'}`)
	lines.push(`  Status: ${notif.status ?? 'unknown'}`)
	if (notif.id) lines.push(`  ID:     ${notif.id}`)
	const created = notif.createdAt ?? notif.created_at
	if (created) lines.push(`  Created: ${timeAgo(created)}`)
	if (notif.content) {
		lines.push('')
		lines.push(`  ${truncate(notif.content, 300)}`)
	}

	if (notif.metadata && Object.keys(notif.metadata).length > 0) {
		const meta = notif.metadata
		const details: string[] = []
		if (Array.isArray(meta.actions)) {
			const labels = (meta.actions as Array<{ label?: string }>).map((a) => a.label).filter(Boolean)
			details.push(
				labels.length > 0 ? `Actions: ${labels.join(', ')}` : `Actions: ${meta.actions.length}`,
			)
		}
		if (meta.question) details.push(`Question: "${truncate(meta.question as string, 80)}"`)
		if (meta.urgency_label) details.push(`Urgency: ${meta.urgency_label}`)
		if (meta.input_type) details.push(`Input: ${meta.input_type}`)
		if (details.length > 0) {
			lines.push('')
			for (const d of details) lines.push(`  ${d}`)
		}
	}

	return lines.join('\n')
}

export function formatNotificationList(notifications: NotificationData[]): string {
	if (!notifications.length)
		return '📢 No notifications. Agents can send notifications with create_notification.'
	const lines: string[] = [`📢 Notifications (${notifications.length})`, '']

	for (const notif of notifications) {
		const icon = NOTIFICATION_ICONS[notif.type ?? ''] ?? '📢'
		const status = notif.status ?? ''
		const created = notif.createdAt ?? notif.created_at
		const ago = timeAgo(created)
		lines.push(`  ${icon} [${status}] ${notif.title || 'Untitled'}${ago ? ` — ${ago}` : ''}`)
		const details: string[] = []
		if (notif.id) details.push(`ID: ${notif.id}`)
		if (notif.content) details.push(`"${truncate(notif.content, 60)}"`)
		if (details.length) lines.push(`    ${details.join('  ')}`)
	}

	return lines.join('\n')
}

// ─── Workspaces ──────────────────────────────────────────

interface WorkspaceData {
	id?: string
	name?: string
	settings?: Record<string, unknown>
	createdAt?: string
	created_at?: string
}

export function formatWorkspace(workspace: WorkspaceData): string {
	const lines: string[] = []
	lines.push(`🏢 ${workspace.name || 'Unnamed workspace'}`)
	lines.push('')
	if (workspace.id) lines.push(`  ID: ${workspace.id}`)
	const created = workspace.createdAt ?? workspace.created_at
	if (created) lines.push(`  Created: ${timeAgo(created)}`)

	if (workspace.settings) {
		const statuses = workspace.settings.statuses as Record<string, string[]> | undefined
		if (statuses) {
			const types = Object.keys(statuses)
			if (types.length > 0) {
				lines.push(`  Object types: ${types.join(', ')}`)
			}
		}
		const fieldDefs = workspace.settings.field_definitions as Record<string, unknown[]> | undefined
		if (fieldDefs) {
			const fieldCount = Object.values(fieldDefs).reduce((sum, f) => sum + (f?.length ?? 0), 0)
			if (fieldCount > 0) {
				const typeCount = Object.keys(fieldDefs).length
				lines.push(
					`  Custom fields: ${fieldCount} across ${typeCount} type${typeCount === 1 ? '' : 's'}`,
				)
			}
		}
		const relTypes = workspace.settings.relationship_types as string[] | undefined
		if (relTypes && relTypes.length > 0) {
			lines.push(`  Relationship types: ${relTypes.join(', ')}`)
		}
	}

	return lines.join('\n')
}

export function formatWorkspaceList(workspaces: WorkspaceData[]): string {
	if (!workspaces.length) return '🏢 No workspaces found.'
	const lines: string[] = [`🏢 Workspaces (${workspaces.length})`, '']
	for (const ws of workspaces) {
		lines.push(`  • ${ws.name || 'Unnamed'} — ${ws.id ?? ''}`)
	}
	return lines.join('\n')
}

// ─── Relationships ───────────────────────────────────────

interface RelationshipData {
	id?: string
	type?: string
	sourceId?: string
	targetId?: string
	source_id?: string
	target_id?: string
}

export function formatRelationshipList(relationships: RelationshipData[]): string {
	if (!relationships.length)
		return '🔗 No relationships found. Use create_objects with edges to link objects.'
	const lines: string[] = [`🔗 Relationships (${relationships.length})`, '']
	for (const rel of relationships) {
		const source = rel.sourceId ?? rel.source_id ?? ''
		const target = rel.targetId ?? rel.target_id ?? ''
		const relId = rel.id ? `[${rel.id}] ` : ''
		lines.push(`  ${relId}${source} → ${rel.type} → ${target}`)
	}
	lines.push('')
	lines.push('Tip: Use get_objects with these IDs to see object details.')
	return lines.join('\n')
}

// ─── Integrations ────────────────────────────────────────

interface IntegrationData {
	id?: string
	provider?: string
	status?: string
	createdAt?: string
	created_at?: string
}

export function formatIntegrationList(integrations: IntegrationData[]): string {
	if (!integrations.length) return '🔌 No integrations connected.'
	const lines: string[] = [`🔌 Integrations (${integrations.length})`, '']
	for (const i of integrations) {
		const created = i.createdAt ?? i.created_at
		const ago = timeAgo(created)
		lines.push(`  • ${i.provider ?? 'unknown'} — ${i.status ?? 'unknown'}${ago ? ` (${ago})` : ''}`)
	}
	return lines.join('\n')
}

interface ProviderData {
	name?: string
	displayName?: string
	display_name?: string
	auth?: { type?: string }
	events?: unknown[]
}

export function formatProviderList(providers: ProviderData[]): string {
	if (!providers.length) return '🔌 No integration providers available.'
	const lines: string[] = [`🔌 Available Providers (${providers.length})`, '']
	for (const p of providers) {
		const name = p.displayName ?? p.display_name ?? p.name ?? 'unknown'
		const auth = p.auth?.type ?? ''
		const eventCount = p.events?.length ?? 0
		lines.push(
			`  • ${name}${auth ? ` (${auth})` : ''}${eventCount ? ` — ${eventCount} events` : ''}`,
		)
	}
	return lines.join('\n')
}

// ─── Extensions ──────────────────────────────────────────

interface ExtensionTypeData {
	type?: string
	display_name?: string
	statuses?: string[]
	fields?: unknown[]
	relationship_types?: string[]
}

interface ExtensionData {
	id?: string
	name?: string
	enabled?: boolean
	types?: ExtensionTypeData[]
	objectTypes?: ExtensionTypeData[]
	object_types?: ExtensionTypeData[]
}

export function formatExtension(ext: ExtensionData): string {
	const enabled = ext.enabled !== false ? '✓ enabled' : '✗ disabled'
	const lines: string[] = []
	lines.push(`🧩 ${ext.name || ext.id || 'Unnamed extension'} (${enabled})`)
	if (ext.id) lines.push(`  ID: ${ext.id}`)
	const types = ext.types ?? ext.objectTypes ?? ext.object_types ?? []
	if (types.length > 0) {
		lines.push('')
		for (const t of types) {
			const displayName = t.display_name ?? t.type ?? 'unknown'
			const typeKey = t.type ? ` (${t.type})` : ''
			const statuses = t.statuses?.join(' → ') ?? ''
			const fieldCount = t.fields?.length ?? 0
			let fieldTag = ''
			if (fieldCount > 0) {
				const fieldNames = (t.fields as Array<{ name?: string }>).map((f) => f.name).filter(Boolean)
				fieldTag =
					fieldNames.length > 0
						? `  [fields: ${fieldNames.join(', ')}]`
						: `  [${fieldCount} field${fieldCount === 1 ? '' : 's'}]`
			}
			lines.push(`  • ${displayName}${typeKey}: ${statuses}${fieldTag}`)
		}
	}
	return lines.join('\n')
}

export function formatExtensionList(extensions: ExtensionData[]): string {
	if (!extensions.length) return '🧩 No extensions found. Use create_extension to add object types.'
	const lines: string[] = [`🧩 Extensions (${extensions.length})`, '']
	for (const ext of extensions) {
		const enabled = ext.enabled !== false ? '✓' : '✗'
		const disabledTag = ext.enabled === false ? ' — disabled' : ''
		const extName = ext.name || ext.id || 'Unnamed'
		const extId = ext.id && ext.id !== ext.name ? ` (${ext.id})` : ''
		lines.push(`  ${enabled} ${extName}${extId}${disabledTag}`)

		const types = ext.types ?? ext.objectTypes ?? ext.object_types ?? []
		for (const t of types) {
			const displayName = t.display_name ?? t.type ?? 'unknown'
			const typeKey = t.type ? ` (${t.type})` : ''
			const statuses = t.statuses?.join(' → ') ?? ''
			const fieldCount = t.fields?.length ?? 0
			const fieldTag = fieldCount > 0 ? `  [${fieldCount} field${fieldCount === 1 ? '' : 's'}]` : ''
			lines.push(`    • ${displayName}${typeKey}: ${statuses}${fieldTag}`)
		}

		lines.push('')
	}
	return lines.join('\n').trimEnd()
}

// ─── Schema ──────────────────────────────────────────────

interface SchemaData {
	types?: Record<
		string,
		{
			display_name?: string
			statuses?: string[]
			fields?: Array<{ name?: string; type?: string; required?: boolean; values?: string[] }>
		}
	>
	relationship_types?: string[]
}

export function formatSchema(schema: SchemaData): string {
	const types = schema.types ?? {}
	const typeCount = Object.keys(types).length
	const relCount = schema.relationship_types?.length ?? 0
	const summary = [
		typeCount > 0 ? `${typeCount} type${typeCount === 1 ? '' : 's'}` : null,
		relCount > 0 ? `${relCount} relationship type${relCount === 1 ? '' : 's'}` : null,
	]
		.filter(Boolean)
		.join(', ')

	const lines: string[] = [`📐 Workspace Schema${summary ? ` — ${summary}` : ''}`, '']

	for (const [typeName, typeDef] of Object.entries(types)) {
		const displayName = typeDef.display_name ?? typeName
		lines.push(`  ${displayName} (${typeName}):`)
		if (typeDef.statuses?.length) {
			lines.push(`    Statuses: ${typeDef.statuses.join(' → ')}`)
		}
		if (typeDef.fields?.length) {
			lines.push('    Fields:')
			for (const field of typeDef.fields) {
				const req = field.required ? ' (required)' : ''
				const vals =
					field.type === 'enum' && field.values?.length ? ` [${field.values.join(', ')}]` : ''
				lines.push(`      • ${field.name}: ${field.type}${req}${vals}`)
			}
		}
		lines.push('')
	}

	if (schema.relationship_types?.length) {
		lines.push(`  Relationship types: ${schema.relationship_types.join(', ')}`)
	}

	return lines.join('\n')
}

// ─── Confirmations ───────────────────────────────────────

export function formatConfirmation(action: string, detail?: string, hint?: string): string {
	const base = detail ? `✅ ${action}: ${detail}` : `✅ ${action}`
	return hint ? `${base}\n${hint}` : base
}

// ─── Dashboard ───────────────────────────────────────────

interface DashboardData {
	workspace?: WorkspaceData
	objects?: ObjectData[]
	events?: EventData[]
	sessions?: SessionData[]
	members?: ActorData[]
}

export function formatDashboard(data: DashboardData): string {
	const lines: string[] = []
	const wsName = data.workspace?.name ?? 'Workspace'
	lines.push(`📊 Workspace Dashboard — "${wsName}"`)

	// Objects by type/status
	const objects = data.objects ?? []
	if (objects.length > 0) {
		const byType: Record<string, Record<string, number>> = {}
		for (const obj of objects) {
			const type = obj.type ?? 'unknown'
			const status = obj.status ?? 'unknown'
			if (!byType[type]) byType[type] = {}
			byType[type][status] = (byType[type][status] ?? 0) + 1
		}

		lines.push('')
		lines.push(`📈 Objects by Type (${objects.length} total)`)
		for (const [type, statuses] of Object.entries(byType)) {
			const parts = Object.entries(statuses).map(([s, c]) => `${c} ${s}`)
			const typeTotal = Object.values(statuses).reduce((a, b) => a + b, 0)
			lines.push(`  ${type}: ${parts.join(', ')} (${typeTotal} total)`)
		}
	} else {
		lines.push('')
		lines.push('📈 No objects yet. Use create_objects to get started.')
	}

	// Recent activity
	const events = data.events ?? []
	if (events.length > 0) {
		lines.push('')
		lines.push('⚡ Recent Activity')
		for (const event of events.slice(0, 10)) {
			lines.push(`  ${formatEvent(event)}`)
		}
		if (events.length > 10) {
			lines.push(`  ... and ${events.length - 10} more events`)
		}
	}

	// Active sessions
	const sessions = (data.sessions ?? []).filter(
		(s) => s.status === 'running' || s.status === 'starting',
	)
	if (sessions.length > 0) {
		lines.push('')
		lines.push('🤖 Active Sessions')
		for (const session of sessions) {
			const idPrefix = session.id ? `${session.id.slice(0, 8)} | ` : ''
			const actor =
				session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id ?? ''
			const prompt = truncate(session.actionPrompt ?? session.action_prompt, 50)
			lines.push(`  • ${idPrefix}${actor} — ${prompt} — ${session.status}`)
		}
	}

	// Team
	const members = data.members ?? []
	if (members.length > 0) {
		lines.push('')
		lines.push(`👥 Team (${members.length} member${members.length === 1 ? '' : 's'})`)
		for (const member of members) {
			const role = member.role ? ` (${member.role})` : ''
			lines.push(`  • ${member.name || 'Unnamed'} — ${member.type ?? 'unknown'}${role}`)
		}
	}

	return lines.join('\n')
}
