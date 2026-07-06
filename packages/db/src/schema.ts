import type { AgentState, FileAnnotation, SessionResult } from '@maskin/shared'
import { sql } from 'drizzle-orm'
import {
	type AnyPgColumn,
	bigint,
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

// ── Actors ──────────────────────────────────────────────────────────────────

export const actors = pgTable('actors', {
	id: uuid('id').defaultRandom().primaryKey(),
	type: text('type').notNull(),
	name: text('name').notNull(),
	email: text('email').unique(),
	apiKey: text('api_key').notNull().unique(),
	passwordHash: text('password_hash'),
	description: text('description'),
	systemPrompt: text('system_prompt'),
	tools: jsonb('tools'),
	memory: jsonb('memory'),
	llmProvider: text('llm_provider'),
	llmConfig: jsonb('llm_config'),
	isSystem: boolean('is_system').notNull().default(false),
	agentState: text('agent_state').notNull().default('idle').$type<AgentState>(),
	agentStateUpdatedAt: timestamp('agent_state_updated_at', { withTimezone: true }),
	// Per-row marker keys for managed-package installs. Nullable everywhere;
	// install-provisioned rows carry { installed_package_id, source_item_id }
	// so the T5 version-push cron can find them. See catalogPackages comment.
	metadata: jsonb('metadata'),
	// biome-ignore lint/suspicious/noExplicitAny: self-referential FK requires type escape
	createdBy: uuid('created_by').references((): any => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	settings: jsonb('settings').notNull().default({}),
	onboardingEnabled: boolean('onboarding_enabled').notNull().default(true),
	createdBy: uuid('created_by').references(() => actors.id),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Workspace Members ───────────────────────────────────────────────────────

export const workspaceMembers = pgTable(
	'workspace_members',
	{
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		role: text('role').notNull(),
		joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.actorId] })],
)

// ── Objects ─────────────────────────────────────────────────────────────────

export const objects = pgTable(
	'objects',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		type: text('type').notNull(),
		title: text('title'),
		content: text('content'),
		status: text('status').notNull(),
		metadata: jsonb('metadata'),
		driver: uuid('driver').references(() => actors.id),
		activeSessionId: uuid('active_session_id'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('objects_ws_type_status_idx').on(t.workspaceId, t.type, t.status),
		// Range-scan path for list_objects(updated_before/updated_after) — the
		// watchdog's stalled-work query. Built CONCURRENTLY in migration 0043.
		index('objects_ws_updated_at_idx').on(t.workspaceId, t.updatedAt),
	],
)

// ── Relationships ───────────────────────────────────────────────────────────

export const relationships = pgTable(
	'relationships',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sourceType: text('source_type').notNull(),
		sourceId: uuid('source_id').notNull(),
		targetType: text('target_type').notNull(),
		targetId: uuid('target_id').notNull(),
		type: text('type').notNull(),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		unique('relationships_src_tgt_type_uniq').on(t.sourceId, t.targetId, t.type),
		check(
			'relationships_source_target_type_kind',
			sql`${t.sourceType} IN ('object', 'file') AND ${t.targetType} IN ('object', 'file')`,
		),
	],
)

// ── Events ──────────────────────────────────────────────────────────────────

export const events = pgTable(
	'events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		data: jsonb('data'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('events_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('events_ws_entity_id_idx').on(t.workspaceId, t.entityId, t.id),
	],
)

// ── Integrations ───────────────────────────────────────────────────────────

export const integrations = pgTable(
	'integrations',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		provider: text('provider').notNull(),
		status: text('status').notNull(),
		externalId: text('external_id'),
		credentials: text('credentials').notNull(),
		config: jsonb('config').notNull().default({}),
		// Per-row marker keys for managed-package installs; nullable everywhere.
		metadata: jsonb('metadata'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		uniqueIndex('integrations_ws_provider_external_uniq')
			.on(t.workspaceId, t.provider, t.externalId)
			.where(sql`${t.externalId} IS NOT NULL`),
		uniqueIndex('integrations_ws_provider_null_external_uniq')
			.on(t.workspaceId, t.provider)
			.where(sql`${t.externalId} IS NULL`),
	],
)

// ── Triggers ────────────────────────────────────────────────────────────────

export const triggers = pgTable('triggers', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id')
		.references(() => workspaces.id)
		.notNull(),
	name: text('name').notNull(),
	type: text('type').notNull(),
	config: jsonb('config').notNull(),
	actionPrompt: text('action_prompt').notNull(),
	targetActorId: uuid('target_actor_id')
		.references(() => actors.id)
		.notNull(),
	enabled: boolean('enabled').notNull().default(true),
	// Per-row marker keys for managed-package installs; nullable everywhere.
	metadata: jsonb('metadata'),
	createdBy: uuid('created_by')
		.references(() => actors.id)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ── Sessions ───────────────────────────────────────────────────────────────

export const sessions = pgTable(
	'sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
		status: text('status').notNull(),
		containerId: text('container_id'),
		// Set by the SessionDispatcher (T6) on a successful production dispatch
		// to apps/agent-server. NULL for local-dev sessions launched via Docker
		// directly from session-manager.
		agentServerId: uuid('agent_server_id').references((): AnyPgColumn => agentServers.id),
		actionPrompt: text('action_prompt').notNull(),
		config: jsonb('config').notNull().default({}),
		interactive: boolean('interactive').notNull().default(false),
		result: jsonb('result').$type<SessionResult>(),
		snapshotPath: text('snapshot_path'),
		sourceSessionId: uuid('source_session_id'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		timeoutAt: timestamp('timeout_at', { withTimezone: true }),
		totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }),
		inputTokens: integer('input_tokens'),
		outputTokens: integer('output_tokens'),
		cacheCreationInputTokens: integer('cache_creation_input_tokens'),
		cacheReadInputTokens: integer('cache_read_input_tokens'),
		durationMs: integer('duration_ms'),
		currentActivity: text('current_activity'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('sessions_ws_status_idx').on(t.workspaceId, t.status),
		// Range-scan path for list_sessions(updated_before/updated_after) — the
		// watchdog's stalled-work query. Built CONCURRENTLY in migration 0044.
		index('sessions_ws_updated_at_idx').on(t.workspaceId, t.updatedAt),
		index('sessions_actor_idx').on(t.actorId),
		index('sessions_actor_completed_idx')
			.on(t.actorId, t.completedAt)
			.where(sql`${t.completedAt} IS NOT NULL`),
		// Hot path for the dispatcher's least-loaded lookup: counts active
		// sessions grouped by agent_server_id.
		index('sessions_agent_server_active_idx')
			.on(t.agentServerId, t.status)
			.where(sql`${t.agentServerId} IS NOT NULL`),
	],
)

// ── Session Logs ───────────────────────────────────────────────────────────

export const sessionLogs = pgTable(
	'session_logs',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		sessionId: uuid('session_id')
			.references(() => sessions.id)
			.notNull(),
		stream: text('stream').notNull(),
		content: text('content').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [index('session_logs_session_idx').on(t.sessionId, t.createdAt)],
)

// ── Agent Files ────────────────────────────────────────────────────────────

export const agentFiles = pgTable(
	'agent_files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		fileType: text('file_type').notNull(),
		path: text('path').notNull(),
		storageKey: text('storage_key').notNull(),
		sizeBytes: integer('size_bytes'),
		sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('agent_files_actor_type_idx').on(t.actorId, t.fileType),
		unique('agent_files_actor_path_uniq').on(t.actorId, t.workspaceId, t.path),
	],
)

// ── Workspace Skills ───────────────────────────────────────────────────────

export const workspaceSkills = pgTable(
	'workspace_skills',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description'),
		content: text('content').notNull(),
		storageKey: text('storage_key').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		isValid: boolean('is_valid').notNull().default(true),
		// Per-row marker keys for managed-package installs; nullable everywhere.
		metadata: jsonb('metadata'),
		createdBy: uuid('created_by').references(() => actors.id),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex('workspace_skills_ws_name_uniq').on(t.workspaceId, t.name),
		check('workspace_skills_name_format', sql`${t.name} ~ '^[a-z0-9-]{1,64}$'`),
	],
)

export type WorkspaceSkill = typeof workspaceSkills.$inferSelect
export type NewWorkspaceSkill = typeof workspaceSkills.$inferInsert

// ── Agent Skills ───────────────────────────────────────────────────────────

export const agentSkills = pgTable(
	'agent_skills',
	{
		actorId: uuid('actor_id')
			.notNull()
			.references(() => actors.id, { onDelete: 'cascade' }),
		workspaceSkillId: uuid('workspace_skill_id')
			.notNull()
			.references(() => workspaceSkills.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.actorId, t.workspaceSkillId] }),
		index('agent_skills_actor_idx').on(t.actorId),
	],
)

export type AgentSkill = typeof agentSkills.$inferSelect
export type NewAgentSkill = typeof agentSkills.$inferInsert

// ── Imports ───────────────────────────────────────────────────────────

export const imports = pgTable(
	'imports',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		status: text('status')
			.$type<'uploading' | 'mapping' | 'importing' | 'completed' | 'failed'>()
			.notNull(),
		fileName: text('file_name').notNull(),
		fileType: text('file_type').notNull(),
		fileStorageKey: text('file_storage_key').notNull(),
		totalRows: integer('total_rows'),
		processedRows: integer('processed_rows').notNull().default(0),
		successCount: integer('success_count').notNull().default(0),
		errorCount: integer('error_count').notNull().default(0),
		mapping: jsonb('mapping'),
		preview: jsonb('preview'),
		errors: jsonb('errors'),
		source: text('source').notNull().default('file'),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
		completedAt: timestamp('completed_at', { withTimezone: true }),
	},
	(t) => [
		index('imports_ws_status_idx').on(t.workspaceId, t.status),
		check(
			'imports_status_check',
			sql`${t.status} IN ('uploading', 'mapping', 'importing', 'completed', 'failed')`,
		),
	],
)

// ── MCP Telemetry ─────────────────────────────────────────────────────────
//
// Records the two events the MCP server emits on every response:
//   - event_type='tool_call'  — per tool response, with hasRichRender + durationMs.
//                                Powers the bet's "50%+ of MCP tool calls render
//                                a rich card" success metric.
//   - event_type='mutation'   — per successful update_objects / delete_object
//                                call. Powers the "20%+ of MCP sessions include
//                                at least one in-chat object mutation" metric.
//
// `session_id` is whatever stable identifier the MCP transport surfaces (the
// MCP session id when present, else a per-process correlation id) and is text,
// not uuid, because we do not control the upstream id format.
export const mcpTelemetry = pgTable(
	'mcp_telemetry',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		// Aggregate-only metric rows — cascade-delete with the workspace so
		// dashboards never read telemetry for a workspace the user has removed.
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id, { onDelete: 'cascade' })
			.notNull(),
		eventType: text('event_type').notNull(),
		toolName: text('tool_name').notNull(),
		sessionId: text('session_id'),
		hasRichRender: boolean('has_rich_render'),
		durationMs: integer('duration_ms'),
		objectType: text('object_type'),
		mutationKind: text('mutation_kind'),
		data: jsonb('data'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('mcp_telemetry_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('mcp_telemetry_ws_event_type_idx').on(t.workspaceId, t.eventType, t.createdAt),
	],
)

// ── Subscriptions ─────────────────────────────────────────────────────────
//
// Polymorphic per-actor subscriptions keyed on (entity_type, entity_id).
// `source` tracks how the row was created — 'author' (creator), 'commenter'
// (auto-attached when they comment), 'mentioned' (auto-attached when they are
// @-mentioned in a comment), or 'manual' (explicit subscribe). Manual/author
// should never be downgraded by a later auto-subscribe.

export const subscriptions = pgTable(
	'subscriptions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		source: text('source').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		unique('subscriptions_actor_entity_uniq').on(t.actorId, t.entityType, t.entityId),
		index('subscriptions_ws_actor_idx').on(t.workspaceId, t.actorId),
		index('subscriptions_entity_idx').on(t.entityType, t.entityId),
		check(
			'subscriptions_source_check',
			sql`${t.source} IN ('manual', 'author', 'commenter', 'mentioned')`,
		),
	],
)

export type Subscription = typeof subscriptions.$inferSelect
export type NewSubscription = typeof subscriptions.$inferInsert

// ── Read State ────────────────────────────────────────────────────────────
//
// Per-actor high-water-mark per subscribable entity. `last_read_event_id`
// references events.id (bigint, monotonic) so the unread query is just a
// simple `> last_read_event_id`. No FK to events — events are not deleted.

export const readState = pgTable(
	'read_state',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		actorId: uuid('actor_id')
			.references(() => actors.id)
			.notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		lastReadEventId: bigint('last_read_event_id', { mode: 'number' }).notNull(),
		lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		unique('read_state_actor_entity_uniq').on(t.actorId, t.entityType, t.entityId),
		index('read_state_ws_actor_idx').on(t.workspaceId, t.actorId),
	],
)

export type ReadState = typeof readState.$inferSelect
export type NewReadState = typeof readState.$inferInsert

// ── Notifications ─────────────────────────────────────────────────────────

export const notifications = pgTable(
	'notifications',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.references(() => workspaces.id)
			.notNull(),
		type: text('type').notNull(),
		title: text('title').notNull(),
		content: text('content'),
		metadata: jsonb('metadata'),
		sourceActorId: uuid('source_actor_id')
			.references(() => actors.id)
			.notNull(),
		targetActorId: uuid('target_actor_id').references(() => actors.id),
		objectId: uuid('object_id').references(() => objects.id, { onDelete: 'set null' }),
		sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
		status: text('status').notNull(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(t) => [
		index('notifications_ws_status_idx').on(t.workspaceId, t.status),
		index('notifications_target_actor_idx').on(t.targetActorId, t.status),
	],
)

// ── Files ─────────────────────────────────────────────────────────────────
//
// Workspace-scoped files authored by agents (or members) and shared via a
// stable URL. Bytes live in S3 under `workspaces/{workspaceId}/files/{id}`;
// this row holds metadata only.
export const files = pgTable(
	'files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description'),
		mimeType: text('mime_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		storageKey: text('storage_key').notNull(),
		// Pinned review annotations (humans pin comments on rendered HTML files).
		// Stored on the row so they round-trip with the file for every reader —
		// UI and MCP get_file — without an extra S3 fetch.
		annotations: jsonb('annotations').notNull().default([]).$type<FileAnnotation[]>(),
		createdBy: uuid('created_by')
			.references(() => actors.id)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('files_ws_created_at_idx').on(t.workspaceId, t.createdAt),
		index('files_ws_name_idx').on(t.workspaceId, t.name),
	],
)

export type File = typeof files.$inferSelect
export type NewFile = typeof files.$inferInsert

// ── Webhook Deliveries ──────────────────────────────────────────────────────
// Idempotency ledger for inbound webhook deliveries. Each row claims a single
// (provider, external_id, workspace_id) tuple so that retries (which reuse the
// same external_id) are short-circuited per workspace instead of being
// reprocessed and creating duplicate events or duplicate downloaded files.
// The key is per-workspace because a single external install (e.g. one Slack
// team) can be connected to multiple Maskin workspaces, and a failed insert
// for one workspace must not block retries for that workspace while still
// deduping workspaces that already succeeded.

export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		provider: text('provider').notNull(),
		externalId: text('external_id').notNull(),
		workspaceId: uuid('workspace_id').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		// Set when downstream work (events insert + any fan-out side effects) commits.
		// NULL means the claim was committed but its work never finished — either
		// still in flight (within threshold) or orphaned by a restart (past threshold).
		// The reconciler releases orphans so the provider's retry can reprocess them.
		processedAt: timestamp('processed_at', { withTimezone: true }),
	},
	(t) => [
		unique('webhook_deliveries_provider_external_id_workspace_id_uniq').on(
			t.provider,
			t.externalId,
			t.workspaceId,
		),
		index('webhook_deliveries_received_at_idx').on(t.receivedAt),
	],
)

// ── Idempotency Records ─────────────────────────────────────────────────────
// Outbound-side idempotency ledger for the API's `Idempotency-Key` header.
// Replaces the previous in-memory cache so that a session snapshot + replay
// (T11/T12 of the session-infra-scale bet) does NOT double-fire side effects:
// the snapshotted agent re-emits the same tool call with the same derived key,
// the ledger short-circuits the duplicate and returns the original response.
//
// `key` is the cache key (`{actorId|anon}:{idempotency-key-header}`).
// `actorId` is stored separately so cleanup queries can scope by actor and
// so the row is interpretable in audit. Anonymous calls (signup) carry NULL.
// `status` + `response` mirror what the original handler returned; replays
// re-emit them as-is.
// `createdAt` drives the 24h sliding TTL — see webhook-deliveries-cleaner.ts
// for the established cleanup pattern.

export const idempotencyRecords = pgTable(
	'idempotency_records',
	{
		key: text('key').primaryKey(),
		actorId: uuid('actor_id'),
		method: text('method').notNull(),
		path: text('path').notNull(),
		status: integer('status').notNull(),
		response: jsonb('response').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index('idempotency_records_created_at_idx').on(t.createdAt)],
)

// ── User Display Settings ───────────────────────────────────────────────────
//
// Per-actor, per-workspace, per-object-type display preferences for the
// objects page (sort, filter, view, column visibility, etc.). v1 only ever
// writes/reads the `'default'` row per (actor, object_type) — the `name`
// column is a forward-compatible carve-out for the Board View bet's named
// saved views, which land as additive rows without a migration.
//
// `settings` is opaque JSONB on purpose: the persistence layer is decoupled
// from the display panel's evolving shape. The toolbar (Task 6) owns the
// concrete `{sort, filter, view, viewConfig}` schema.

export const userDisplaySettings = pgTable(
	'user_display_settings',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		actorId: uuid('actor_id')
			.notNull()
			.references(() => actors.id, { onDelete: 'cascade' }),
		objectType: text('object_type').notNull(),
		name: text('name').notNull().default('default'),
		settings: jsonb('settings').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('user_display_settings_ws_actor_type_name_uniq').on(
			t.workspaceId,
			t.actorId,
			t.objectType,
			t.name,
		),
		index('user_display_settings_ws_actor_type_idx').on(t.workspaceId, t.actorId, t.objectType),
	],
)

export type UserDisplaySettings = typeof userDisplaySettings.$inferSelect
export type NewUserDisplaySettings = typeof userDisplaySettings.$inferInsert

// ── Workspace Onboarding Prompts ──────────────────────────────────────────────
//
// One row per prompt type per workspace. Written when onboarding is enabled;
// `answered_at` and `object_id` are filled in once the owner replies and the
// knowledge object is created.

export const workspaceOnboardingPrompts = pgTable(
	'workspace_onboarding_prompts',
	{
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		promptType: text('prompt_type').notNull(),
		sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
		answeredAt: timestamp('answered_at', { withTimezone: true }),
		objectId: uuid('object_id'),
	},
	(t) => [
		primaryKey({ columns: [t.workspaceId, t.promptType] }),
		check(
			'workspace_onboarding_prompts_prompt_type_check',
			sql`${t.promptType} IN ('product_vision','icp','first_bet_hypothesis','north_star_metric','customer_evidence')`,
		),
	],
)

export type WorkspaceOnboardingPrompt = typeof workspaceOnboardingPrompts.$inferSelect
export type NewWorkspaceOnboardingPrompt = typeof workspaceOnboardingPrompts.$inferInsert

// ── Catalog Packages ──────────────────────────────────────────────────────────
//
// Vetted, installable loops (formerly "bundles") of actors, triggers, skills,
// and integrations. Any workspace can install a package and Maskin pushes
// version updates to locked installs via the cron in T5. A package is a single
// row here; the elements it ships with live in `catalog_package_items` as
// frozen snapshots, one per published version.
//
// Re-provisioning convention — every actor/trigger/skill/integration row
// created by an install must carry `metadata.installed_package_id` (the
// `installed_packages.id` row) and `metadata.source_item_id` (the
// `catalog_package_items.source_item_id` it was provisioned from). The
// version-push cron uses both keys to find what to update and to resolve
// intra-package wiring (e.g. a trigger whose `target_actor_id` points at an
// agent in the same loop) against the snapshot graph instead of the live
// publisher workspace. Carried as a nullable `metadata jsonb` column on each
// of the four element tables (added by 0035_install_metadata.sql) so non-
// install rows pay nothing and install rows are findable by a partial
// expression index on `metadata->>'installed_package_id'`.

export const catalogPackages = pgTable('catalog_packages', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description').notNull(),
	version: text('version').notNull(),
	useCase: text('use_case'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CatalogPackage = typeof catalogPackages.$inferSelect
export type NewCatalogPackage = typeof catalogPackages.$inferInsert

// ── Catalog Package Items ─────────────────────────────────────────────────────
//
// Frozen snapshots of each element that ships with a published package.
// `source_item_id` is the original actor/trigger/skill/integration id in the
// publishing workspace — kept so intra-package wiring inside `item_snapshot`
// (e.g. a `target_actor_id` referencing another item in the same package) can
// be resolved against this set of rows during install and re-provisioning.

export const catalogPackageItems = pgTable(
	'catalog_package_items',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		packageId: uuid('package_id')
			.notNull()
			.references(() => catalogPackages.id, { onDelete: 'cascade' }),
		itemType: text('item_type').notNull(),
		sourceItemId: uuid('source_item_id').notNull(),
		itemSnapshot: jsonb('item_snapshot').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('catalog_package_items_package_idx').on(t.packageId),
		index('catalog_package_items_package_source_idx').on(t.packageId, t.sourceItemId),
		check(
			'catalog_package_items_item_type_check',
			sql`${t.itemType} IN ('actor', 'trigger', 'skill', 'integration')`,
		),
	],
)

export type CatalogPackageItem = typeof catalogPackageItems.$inferSelect
export type NewCatalogPackageItem = typeof catalogPackageItems.$inferInsert

// ── Installed Packages ────────────────────────────────────────────────────────
//
// One row per package installed into a workspace. `is_locked` defaults to true
// — Maskin owns the install and pushes version updates via the cron in T5
// until the workspace explicitly forks. Forking sets `forked_at` and flips
// `is_locked` to false; the row is preserved so install lineage survives the
// fork. The `source_locked_idx` keys the cron's "all locked installs of this
// package" lookup; the `(workspace_id, source_package_id)` unique key prevents
// double-installs of the same catalog package into one workspace.

export const installedPackages = pgTable(
	'installed_packages',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		sourcePackageId: uuid('source_package_id')
			.notNull()
			.references(() => catalogPackages.id),
		installedVersion: text('installed_version').notNull(),
		isLocked: boolean('is_locked').notNull().default(true),
		forkedAt: timestamp('forked_at', { withTimezone: true }),
		installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('installed_packages_ws_source_uniq').on(t.workspaceId, t.sourcePackageId),
		index('installed_packages_source_locked_idx').on(t.sourcePackageId, t.isLocked),
	],
)

export type InstalledPackage = typeof installedPackages.$inferSelect
export type NewInstalledPackage = typeof installedPackages.$inferInsert

// ── Loop Active Days ──────────────────────────────────────────────────────────
//
// One row per (installed_package_id, UTC day) that has emitted a
// `loop_active_day` PostHog event. The PRIMARY KEY is the idempotency
// guarantee: the session-completion path runs INSERT ... ON CONFLICT DO
// NOTHING and only fires the analytics event when the insert actually
// added a row. The ON DELETE CASCADE drops the rows automatically when an
// install is deleted, so an install re-created later for the same
// workspace + package can emit `loop_active_day` again from day one.

export const loopActiveDays = pgTable(
	'loop_active_days',
	{
		installedPackageId: uuid('installed_package_id')
			.notNull()
			.references(() => installedPackages.id, { onDelete: 'cascade' }),
		utcDay: text('utc_day').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.installedPackageId, t.utcDay] })],
)

export type LoopActiveDay = typeof loopActiveDays.$inferSelect
export type NewLoopActiveDay = typeof loopActiveDays.$inferInsert

// ── Agent Servers ─────────────────────────────────────────────────────────
//
// Pool of microsandbox-running hosts. `SessionDispatcher` in apps/dev picks
// an `active` row with capacity (least-loaded) and routes session-start over
// HTTPS, using `secret` as the bearer token. v1 seeds one row for the Finland
// host via env-var-backed `seed-agent-servers.ts`; adding a second host is
// a single row insert with no code change.

export const agentServers = pgTable(
	'agent_servers',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		url: text('url').notNull().unique(),
		secret: text('secret').notNull(),
		maxConcurrentSessions: integer('max_concurrent_sessions').notNull(),
		status: text('status').notNull().$type<'active' | 'draining' | 'disabled'>(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		check('agent_servers_status_check', sql`${t.status} IN ('active', 'draining', 'disabled')`),
	],
)

export type AgentServer = typeof agentServers.$inferSelect
export type NewAgentServer = typeof agentServers.$inferInsert

// ── Session Dispatch Attempts ───────────────────────────────────────────────
//
// Postgres-backed dispatch queue for session-start calls from apps/dev to
// apps/agent-server. Absorbs backpressure when no agent-server has capacity
// and retries failed dispatches with exponential backoff. The same
// `idempotency_key` is reused across every retry of a given session — the
// receiver and downstream side-effect layer (per the idempotency middleware)
// dedupe any double-fire.
//
// One row per session_id (UNIQUE). Re-enqueueing the same session is an
// UPSERT. Status moves pending → row deleted on dispatch, or pending →
// failed on permanent failure or after max_attempts is exhausted.

export const sessionDispatchAttempts = pgTable(
	'session_dispatch_attempts',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sessionId: uuid('session_id')
			.notNull()
			.references(() => sessions.id, { onDelete: 'cascade' }),
		idempotencyKey: text('idempotency_key').notNull(),
		attempt: integer('attempt').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		status: text('status').notNull().default('pending'),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastError: text('last_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique('session_dispatch_attempts_session_id_uniq').on(t.sessionId),
		check('session_dispatch_attempts_status_check', sql`${t.status} IN ('pending','failed')`),
		index('session_dispatch_attempts_ready_idx').on(t.status, t.nextAttemptAt),
	],
)

export type SessionDispatchAttempt = typeof sessionDispatchAttempts.$inferSelect
export type NewSessionDispatchAttempt = typeof sessionDispatchAttempts.$inferInsert
