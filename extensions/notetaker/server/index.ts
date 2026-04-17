import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, triggers, workspaceMembers, workspaces } from '@maskin/db/schema'
import type { ModuleDefinition, ModuleEnv, ModuleLifecycleContext } from '@maskin/module-sdk'
import { and, eq } from 'drizzle-orm'
import { MEETING_RELATIONSHIP_TYPES, MEETING_STATUSES, MODULE_ID, MODULE_NAME } from '../shared.js'

// ── Deterministic names — used for idempotent lookup/creation ────────────────
const SUMMARIZER_AGENT_NAME = 'Meeting Summarizer'
const DISPATCHER_AGENT_NAME = 'Skjald Dispatcher'
const TRIGGER_MEETING_CREATED = 'meeting.created'
const TRIGGER_TRANSCRIPT_ATTACHED = 'transcript.attached'
const TRIGGER_CALENDAR_SYNC = 'calendar.sync'

const SUMMARIZER_SYSTEM_PROMPT = [
	'You are the Meeting Summarizer for the Maskin notetaker extension.',
	'When a meeting object transitions to having a transcript (metadata.transcriptUrl set),',
	'fetch the transcript from the provided S3 URL, write a concise summary,',
	'and extract action items and open questions.',
	'Create an `insight` object for the summary linked to the meeting via `about`,',
	'and a `task` object for each action item linked to the meeting via `produced`.',
	'Do NOT create `decision` objects.',
].join(' ')

const DISPATCHER_SYSTEM_PROMPT = [
	'You are the Skjald Dispatcher for the Maskin notetaker extension.',
	'When a meeting object fires this trigger and has `skjaldJoin=true`,',
	'call the Skjald MCP tool `skjald_join_meeting` with the meeting URL,',
	'bot name, language, and meeting id so Skjald can join and record the meeting.',
].join(' ')

const SUMMARIZER_PROMPT = [
	'A meeting transcript was just attached. Summarize the transcript at metadata.transcriptUrl,',
	'extract action items and open questions, and create linked `insight` and `task` objects.',
].join(' ')

const DISPATCHER_PROMPT = [
	'A meeting is ready to be joined. Call the Skjald `skjald_join_meeting` MCP tool with',
	'the meetingUrl, botName, language, and meeting id from the triggering event.',
].join(' ')

interface NotetakerConfig {
	autoJoin: boolean
	defaultLanguage: string
	botName: string
	syncIntervalMinutes: number
	summarizerActorId?: string
	dispatcherActorId?: string
	meetingCreatedTriggerId?: string
	transcriptReadyTriggerId?: string
	calendarSyncTriggerId?: string
}

const DEFAULT_CONFIG: NotetakerConfig = {
	autoJoin: true,
	defaultLanguage: 'en',
	botName: 'Maskin Notetaker',
	syncIntervalMinutes: 10,
}

function cronExpressionFor(minutes: number): string {
	const m = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 60) : 10
	return `*/${m} * * * *`
}

async function readConfig(
	db: Database,
	workspaceId: string,
): Promise<{
	settings: Record<string, unknown>
	config: NotetakerConfig
}> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const settings = (row?.settings as Record<string, unknown>) ?? {}
	const customExtensions =
		(settings.custom_extensions as Record<string, { config?: Partial<NotetakerConfig> }>) ?? {}
	const stored = customExtensions[MODULE_ID]?.config ?? {}
	return {
		settings,
		config: { ...DEFAULT_CONFIG, ...stored },
	}
}

async function writeConfig(
	db: Database,
	workspaceId: string,
	settings: Record<string, unknown>,
	config: NotetakerConfig,
): Promise<void> {
	const customExtensions =
		(settings.custom_extensions as Record<string, Record<string, unknown>>) ?? {}
	const existingEntry = customExtensions[MODULE_ID] ?? {
		name: MODULE_NAME,
		types: ['meeting'],
		relationship_types: [...MEETING_RELATIONSHIP_TYPES],
		enabled: true,
	}
	const nextSettings = {
		...settings,
		custom_extensions: {
			...customExtensions,
			[MODULE_ID]: {
				...existingEntry,
				config,
			},
		},
	}
	await db
		.update(workspaces)
		.set({ settings: nextSettings, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))
}

async function ensureAgent(
	db: Database,
	workspaceId: string,
	creatorActorId: string,
	name: string,
	systemPrompt: string,
	existingId: string | undefined,
): Promise<string> {
	if (existingId) {
		const [existing] = await db.select().from(actors).where(eq(actors.id, existingId)).limit(1)
		if (existing) return existing.id
	}
	const { key } = generateApiKey()
	const [created] = await db
		.insert(actors)
		.values({
			type: 'agent',
			name,
			apiKey: key,
			systemPrompt,
			createdBy: creatorActorId,
		})
		.returning({ id: actors.id })
	if (!created) throw new Error(`Failed to create agent '${name}'`)
	await db
		.insert(workspaceMembers)
		.values({ workspaceId, actorId: created.id, role: 'member' })
		.onConflictDoNothing()
	return created.id
}

async function ensureTrigger(
	db: Database,
	workspaceId: string,
	creatorActorId: string,
	spec: {
		name: string
		type: 'cron' | 'event'
		config: Record<string, unknown>
		actionPrompt: string
		targetActorId: string
	},
	existingId: string | undefined,
): Promise<string> {
	if (existingId) {
		const [existing] = await db
			.select()
			.from(triggers)
			.where(and(eq(triggers.id, existingId), eq(triggers.workspaceId, workspaceId)))
			.limit(1)
		if (existing) {
			// Keep the trigger in sync with current target/prompt/config — idempotent re-apply.
			await db
				.update(triggers)
				.set({
					name: spec.name,
					type: spec.type,
					config: spec.config,
					actionPrompt: spec.actionPrompt,
					targetActorId: spec.targetActorId,
					enabled: true,
					updatedAt: new Date(),
				})
				.where(eq(triggers.id, existing.id))
			return existing.id
		}
	}
	const [created] = await db
		.insert(triggers)
		.values({
			workspaceId,
			name: spec.name,
			type: spec.type,
			config: spec.config,
			actionPrompt: spec.actionPrompt,
			targetActorId: spec.targetActorId,
			enabled: true,
			createdBy: creatorActorId,
		})
		.returning({ id: triggers.id })
	if (!created) throw new Error(`Failed to create trigger '${spec.name}'`)
	return created.id
}

async function deleteTriggerIfExists(db: Database, id: string | undefined): Promise<void> {
	if (!id) return
	await db.delete(triggers).where(eq(triggers.id, id))
}

async function deleteAgentIfExists(db: Database, id: string | undefined): Promise<void> {
	if (!id) return
	await db.delete(workspaceMembers).where(eq(workspaceMembers.actorId, id))
	await db.delete(actors).where(and(eq(actors.id, id), eq(actors.type, 'agent')))
}

async function onEnable(env: ModuleEnv, ctx: ModuleLifecycleContext): Promise<void> {
	const { db } = env
	const { workspaceId, actorId } = ctx

	const { settings, config } = await readConfig(db, workspaceId)

	const summarizerActorId = await ensureAgent(
		db,
		workspaceId,
		actorId,
		SUMMARIZER_AGENT_NAME,
		SUMMARIZER_SYSTEM_PROMPT,
		config.summarizerActorId,
	)
	const dispatcherActorId = await ensureAgent(
		db,
		workspaceId,
		actorId,
		DISPATCHER_AGENT_NAME,
		DISPATCHER_SYSTEM_PROMPT,
		config.dispatcherActorId,
	)

	const meetingCreatedTriggerId = await ensureTrigger(
		db,
		workspaceId,
		actorId,
		{
			name: TRIGGER_MEETING_CREATED,
			type: 'event',
			config: {
				entity_type: 'meeting',
				action: 'created',
				conditions: [{ field: 'skjaldJoin', operator: 'equals', value: true }],
			},
			actionPrompt: DISPATCHER_PROMPT,
			targetActorId: dispatcherActorId,
		},
		config.meetingCreatedTriggerId,
	)
	const transcriptReadyTriggerId = await ensureTrigger(
		db,
		workspaceId,
		actorId,
		{
			name: TRIGGER_TRANSCRIPT_ATTACHED,
			type: 'event',
			config: {
				entity_type: 'meeting',
				action: 'updated',
				conditions: [{ field: 'transcriptUrl', operator: 'is_set' }],
			},
			actionPrompt: SUMMARIZER_PROMPT,
			targetActorId: summarizerActorId,
		},
		config.transcriptReadyTriggerId,
	)
	const calendarSyncTriggerId = await ensureTrigger(
		db,
		workspaceId,
		actorId,
		{
			name: TRIGGER_CALENDAR_SYNC,
			type: 'cron',
			config: { expression: cronExpressionFor(config.syncIntervalMinutes) },
			actionPrompt: 'Sync calendar events into meeting objects.',
			targetActorId: dispatcherActorId,
		},
		config.calendarSyncTriggerId,
	)

	await writeConfig(db, workspaceId, settings, {
		...config,
		summarizerActorId,
		dispatcherActorId,
		meetingCreatedTriggerId,
		transcriptReadyTriggerId,
		calendarSyncTriggerId,
	})
}

async function onDisable(env: ModuleEnv, ctx: ModuleLifecycleContext): Promise<void> {
	const { db } = env
	const { workspaceId } = ctx

	const { settings, config } = await readConfig(db, workspaceId)

	await deleteTriggerIfExists(db, config.meetingCreatedTriggerId)
	await deleteTriggerIfExists(db, config.transcriptReadyTriggerId)
	await deleteTriggerIfExists(db, config.calendarSyncTriggerId)
	await deleteAgentIfExists(db, config.summarizerActorId)
	await deleteAgentIfExists(db, config.dispatcherActorId)

	const {
		summarizerActorId: _a,
		dispatcherActorId: _b,
		meetingCreatedTriggerId: _c,
		transcriptReadyTriggerId: _d,
		calendarSyncTriggerId: _e,
		...remaining
	} = config
	await writeConfig(db, workspaceId, settings, remaining as NotetakerConfig)
}

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: 'Meeting',
			icon: 'video',
			defaultStatuses: [...MEETING_STATUSES],
			defaultRelationshipTypes: [...MEETING_RELATIONSHIP_TYPES],
		},
	],
	defaultSettings: {
		display_names: {
			meeting: 'Meeting',
		},
		statuses: {
			meeting: [...MEETING_STATUSES],
		},
	},
	onEnable,
	onDisable,
}

export default notetakerExtension
