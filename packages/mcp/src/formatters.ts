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
		return opts?.query ? `📋 No objects found matching "${opts.query}".` : '📋 No objects found.'
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
		const type = pad(obj.type ?? '', typeWidth)
		const status = pad(obj.status ?? '', statusWidth)
		const title = truncate(obj.title, 40)
		const ago = timeAgo(created)
		lines.push(`  ${type} | ${status} | ${title}${ago ? ` | ${ago}` : ''}`)
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
	return lines.join('\n')
}

export function formatActorList(actors: ActorData[]): string {
	if (!actors.length) return '👥 No team members found.'
	const lines: string[] = [`👥 Team (${actors.length} member${actors.length === 1 ? '' : 's'})`, '']
	for (const actor of actors) {
		const role = actor.role ? ` (${actor.role})` : ''
		lines.push(`  • ${actor.name || 'Unnamed'} — ${actor.type ?? 'unknown'}${role}`)
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

	lines.push(`🤖 Session — ${status}`)
	lines.push('')
	if (session.id) lines.push(`  ID:     ${session.id}`)
	lines.push(`  Status: ${status}`)
	const actor = session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id
	if (actor) lines.push(`  Actor:  ${actor}`)
	if (prompt) lines.push(`  Prompt: ${truncate(prompt, 100)}`)
	if (created) lines.push(`  Started: ${timeAgo(created)}`)

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
	if (!sessions.length) return '🤖 No sessions found.'
	const lines: string[] = [`🤖 Sessions (${sessions.length})`, '']

	const statusWidth = Math.max(...sessions.map((s) => (s.status ?? '').length), 6)

	for (const session of sessions) {
		const status = pad(session.status ?? '', statusWidth)
		const actor =
			session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id ?? ''
		const prompt = truncate(session.actionPrompt ?? session.action_prompt, 50)
		const created = session.createdAt ?? session.created_at
		const ago = timeAgo(created)
		lines.push(
			`  ${status} | ${actor ? `${truncate(actor, 20)} | ` : ''}${prompt}${ago ? ` | ${ago}` : ''}`,
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
			lines.push(`  Schedule: ${trigger.config.expression}`)
		} else if (trigger.type === 'event') {
			const entityType = trigger.config.entity_type ?? trigger.config.entityType ?? ''
			const action = trigger.config.action ?? ''
			lines.push(`  Fires on: ${entityType} ${action}`)
		}
	}

	const prompt = trigger.actionPrompt ?? trigger.action_prompt
	if (prompt) lines.push(`  Prompt: ${truncate(prompt, 100)}`)
	const actor = trigger.targetActorId ?? trigger.target_actor_id
	if (actor) lines.push(`  Target actor: ${actor}`)

	return lines.join('\n')
}

export function formatTriggerList(triggers: TriggerData[]): string {
	if (!triggers.length) return '⚙️ No triggers configured.'
	const lines: string[] = [`⚙️ Triggers (${triggers.length})`, '']

	for (const trigger of triggers) {
		const enabled = trigger.enabled !== false ? '✓' : '✗'
		const type = trigger.type ?? ''
		const schedule =
			type === 'cron' && trigger.config?.expression ? ` [${trigger.config.expression}]` : ''
		lines.push(`  ${enabled} ${trigger.name || 'Unnamed'}${schedule} — ${type}`)
	}

	return lines.join('\n')
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
	return lines.join('\n')
}

export function formatNotificationList(notifications: NotificationData[]): string {
	if (!notifications.length) return '📢 No notifications.'
	const lines: string[] = [`📢 Notifications (${notifications.length})`, '']

	for (const notif of notifications) {
		const icon = NOTIFICATION_ICONS[notif.type ?? ''] ?? '📢'
		const status = notif.status ?? ''
		const created = notif.createdAt ?? notif.created_at
		const ago = timeAgo(created)
		lines.push(`  ${icon} [${status}] ${notif.title || 'Untitled'}${ago ? ` — ${ago}` : ''}`)
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
	if (!relationships.length) return '🔗 No relationships found.'
	const lines: string[] = [`🔗 Relationships (${relationships.length})`, '']
	for (const rel of relationships) {
		const source = (rel.sourceId ?? rel.source_id ?? '').slice(0, 8)
		const target = (rel.targetId ?? rel.target_id ?? '').slice(0, 8)
		lines.push(`  ${source}… → ${rel.type} → ${target}…`)
	}
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

interface ExtensionData {
	id?: string
	name?: string
	enabled?: boolean
	types?: Array<{ type?: string; display_name?: string; statuses?: string[] }>
	objectTypes?: Array<{ type?: string; display_name?: string; statuses?: string[] }>
	object_types?: Array<{ type?: string; display_name?: string; statuses?: string[] }>
}

export function formatExtension(ext: ExtensionData): string {
	const enabled = ext.enabled !== false ? '✓ enabled' : '✗ disabled'
	const lines: string[] = []
	lines.push(`🧩 ${ext.name || ext.id || 'Unnamed extension'} (${enabled})`)
	const types = ext.types ?? ext.objectTypes ?? ext.object_types ?? []
	if (types.length > 0) {
		lines.push('')
		for (const t of types) {
			const name = t.display_name ?? t.type ?? 'unknown'
			const statuses = t.statuses?.join(', ') ?? ''
			lines.push(`  • ${name}${statuses ? `: ${statuses}` : ''}`)
		}
	}
	return lines.join('\n')
}

export function formatExtensionList(extensions: ExtensionData[]): string {
	if (!extensions.length) return '🧩 No extensions found.'
	const lines: string[] = [`🧩 Extensions (${extensions.length})`, '']
	for (const ext of extensions) {
		const enabled = ext.enabled !== false ? '✓' : '✗'
		const types = ext.types ?? ext.objectTypes ?? ext.object_types ?? []
		const typeCount = types.length
		lines.push(
			`  ${enabled} ${ext.name || ext.id || 'Unnamed'}${typeCount ? ` — ${typeCount} type${typeCount === 1 ? '' : 's'}` : ''}`,
		)
	}
	return lines.join('\n')
}

// ─── Schema ──────────────────────────────────────────────

interface SchemaData {
	types?: Record<
		string,
		{
			display_name?: string
			statuses?: string[]
			fields?: Array<{ name?: string; type?: string; required?: boolean }>
		}
	>
	relationship_types?: string[]
}

export function formatSchema(schema: SchemaData): string {
	const lines: string[] = ['📐 Workspace Schema', '']

	const types = schema.types ?? {}
	for (const [typeName, typeDef] of Object.entries(types)) {
		const displayName = typeDef.display_name ?? typeName
		lines.push(`  ${displayName} (${typeName}):`)
		if (typeDef.statuses?.length) {
			lines.push(`    Statuses: ${typeDef.statuses.join(', ')}`)
		}
		if (typeDef.fields?.length) {
			lines.push('    Fields:')
			for (const field of typeDef.fields) {
				const req = field.required ? ' (required)' : ''
				lines.push(`      • ${field.name}: ${field.type}${req}`)
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

export function formatConfirmation(action: string, detail?: string): string {
	return detail ? `✅ ${action}: ${detail}` : `✅ ${action}`
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
		lines.push('📈 Objects by Type')
		for (const [type, statuses] of Object.entries(byType)) {
			const parts = Object.entries(statuses).map(([s, c]) => `${c} ${s}`)
			lines.push(`  ${type}: ${parts.join(', ')}`)
		}
	} else {
		lines.push('')
		lines.push('📈 No objects yet')
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
			const actor =
				session.actorName ?? session.actor_name ?? session.actorId ?? session.actor_id ?? ''
			const prompt = truncate(session.actionPrompt ?? session.action_prompt, 50)
			lines.push(`  • ${actor} — ${prompt} — ${session.status}`)
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
