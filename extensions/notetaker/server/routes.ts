import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, integrations, objects, workspaces } from '@maskin/db/schema'
import type { ModuleEnv } from '@maskin/module-sdk'
import { and, eq, sql } from 'drizzle-orm'
import { MEETING_RELATIONSHIP_TYPES, MODULE_ID, MODULE_NAME } from '../shared.js'
import { decryptIntegrationCredentials } from './lib/crypto.js'
import { type NormalizedCalendarEvent, listGoogleCalendarEvents } from './sync/google-calendar.js'
import { listOutlookEvents } from './sync/microsoft-outlook.js'

// Context variables set by apps/dev middleware. Narrow via helpers rather than
// generic typing so the returned OpenAPIHono matches the ModuleDefinition.routes
// default env (which has `Variables: object | undefined`).
function getDb(c: { get: (k: string) => unknown }): Database {
	return c.get('db') as Database
}
function getActorId(c: { get: (k: string) => unknown }): string {
	return c.get('actorId') as string
}

const errorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
})

function errorBody(code: string, message: string) {
	return { error: { code, message } }
}

const workspaceIdHeader = z.object({
	'x-workspace-id': z.string().uuid(),
})

// ── Config schema ──────────────────────────────────────────────────────────

/**
 * Strict schema for the extension-owned notetaker config block. Lifecycle-hook
 * fields (agents/triggers created by onEnable) are read-only from the HTTP API
 * — the UI only writes user-editable fields.
 */
const userEditableConfigSchema = z.object({
	autoJoin: z.boolean(),
	defaultLanguage: z.string().min(1),
	botName: z.string().min(1),
	syncIntervalMinutes: z.number().int().min(1).max(60),
})

const configResponseSchema = userEditableConfigSchema.extend({
	summarizerActorId: z.string().uuid().optional(),
	dispatcherActorId: z.string().uuid().optional(),
	meetingCreatedTriggerId: z.string().uuid().optional(),
	transcriptReadyTriggerId: z.string().uuid().optional(),
	calendarSyncTriggerId: z.string().uuid().optional(),
})

const DEFAULT_USER_CONFIG: z.infer<typeof userEditableConfigSchema> = {
	autoJoin: true,
	defaultLanguage: 'en',
	botName: 'Maskin Notetaker',
	syncIntervalMinutes: 10,
}

type WorkspaceSettings = {
	custom_extensions?: Record<string, { config?: Record<string, unknown> } & Record<string, unknown>>
	[key: string]: unknown
}

async function readSettings(db: Database, workspaceId: string) {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!row) return null
	return {
		row,
		settings: (row.settings as WorkspaceSettings) ?? {},
	}
}

function readConfigBlock(settings: WorkspaceSettings): Record<string, unknown> {
	const customExtensions = settings.custom_extensions ?? {}
	return (customExtensions[MODULE_ID]?.config as Record<string, unknown>) ?? {}
}

// ── POST /sync-calendars ───────────────────────────────────────────────────

const syncCalendarsRoute = createRoute({
	method: 'post',
	path: '/sync-calendars',
	tags: ['Notetaker'],
	summary: 'Sync calendar events from connected integrations into meeting objects',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Sync result summary',
			content: {
				'application/json': {
					schema: z.object({
						synced: z.number(),
						created: z.number(),
						updated: z.number(),
						providers: z.array(
							z.object({
								provider: z.string(),
								synced: z.number(),
								error: z.string().optional(),
							}),
						),
					}),
				},
			},
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const CALENDAR_PROVIDERS = ['google-calendar', 'microsoft-outlook'] as const
type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number]

async function fetchEventsForProvider(
	provider: CalendarProvider,
	credentials: { accessToken?: string },
): Promise<NormalizedCalendarEvent[]> {
	if (!credentials.accessToken) {
		throw new Error(`Integration has no access token — user must reconnect ${provider}`)
	}
	if (provider === 'google-calendar') {
		return listGoogleCalendarEvents(credentials.accessToken)
	}
	return listOutlookEvents(credentials.accessToken)
}

async function upsertMeeting(
	db: Database,
	workspaceId: string,
	actorId: string,
	provider: CalendarProvider,
	event: NormalizedCalendarEvent,
): Promise<'created' | 'updated'> {
	const [existing] = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'meeting'),
				sql`${objects.metadata}->>'calendarEventId' = ${event.calendarEventId}`,
			),
		)
		.limit(1)

	const metadataPatch = {
		calendarEventId: event.calendarEventId,
		calendarProvider: provider,
		meetingUrl: event.meetingUrl,
		startTime: event.startTime,
		endTime: event.endTime,
	}

	if (existing) {
		const mergedMetadata = {
			...((existing.metadata as Record<string, unknown> | null) ?? {}),
			...metadataPatch,
		}
		const [updated] = await db
			.update(objects)
			.set({
				title: event.title ?? existing.title,
				metadata: mergedMetadata,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, existing.id))
			.returning()
		if (updated) {
			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'meeting',
				entityId: updated.id,
				data: { previous: existing, updated },
			})
		}
		return 'updated'
	}

	const [created] = await db
		.insert(objects)
		.values({
			workspaceId,
			type: 'meeting',
			title: event.title,
			content: event.description,
			status: 'scheduled',
			metadata: metadataPatch,
			createdBy: actorId,
		})
		.returning()

	if (created) {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'meeting',
			entityId: created.id,
			data: created,
		})
	}
	return 'created'
}

export function createNotetakerRoutes(_env: ModuleEnv): OpenAPIHono {
	const app = new OpenAPIHono()

	app.openapi(syncCalendarsRoute, async (c) => {
		const db = getDb(c)
		const actorId = getActorId(c)
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')

		const existing = await readSettings(db, workspaceId)
		if (!existing) {
			return c.json(errorBody('NOT_FOUND', 'Workspace not found'), 404)
		}

		const rows = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, workspaceId))

		const connected = rows.filter((r): r is typeof r & { provider: CalendarProvider } =>
			(CALENDAR_PROVIDERS as readonly string[]).includes(r.provider),
		)

		let created = 0
		let updated = 0
		const perProvider: { provider: string; synced: number; error?: string }[] = []

		for (const integration of connected) {
			let providerSynced = 0
			try {
				const credentials = JSON.parse(decryptIntegrationCredentials(integration.credentials)) as {
					accessToken?: string
				}
				const eventsList = await fetchEventsForProvider(integration.provider, credentials)
				for (const event of eventsList) {
					const result = await upsertMeeting(db, workspaceId, actorId, integration.provider, event)
					if (result === 'created') created++
					else updated++
					providerSynced++
				}
				perProvider.push({ provider: integration.provider, synced: providerSynced })
			} catch (err) {
				perProvider.push({
					provider: integration.provider,
					synced: providerSynced,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		return c.json(
			{
				synced: created + updated,
				created,
				updated,
				providers: perProvider,
			},
			200,
		)
	})

	// ── GET /config ────────────────────────────────────────────────────────

	app.openapi(
		createRoute({
			method: 'get',
			path: '/config',
			tags: ['Notetaker'],
			summary: 'Read notetaker config for the workspace',
			request: { headers: workspaceIdHeader },
			responses: {
				200: {
					description: 'Notetaker config',
					content: { 'application/json': { schema: configResponseSchema } },
				},
				404: {
					description: 'Workspace not found',
					content: { 'application/json': { schema: errorSchema } },
				},
			},
		}),
		async (c) => {
			const db = getDb(c)
			const { 'x-workspace-id': workspaceId } = c.req.valid('header')

			const existing = await readSettings(db, workspaceId)
			if (!existing) {
				return c.json(errorBody('NOT_FOUND', 'Workspace not found'), 404)
			}

			const stored = readConfigBlock(existing.settings)
			const merged = { ...DEFAULT_USER_CONFIG, ...stored } as z.infer<typeof configResponseSchema>
			return c.json(merged, 200)
		},
	)

	// ── PUT /config ────────────────────────────────────────────────────────

	app.openapi(
		createRoute({
			method: 'put',
			path: '/config',
			tags: ['Notetaker'],
			summary: 'Update notetaker config for the workspace',
			request: {
				headers: workspaceIdHeader,
				body: {
					content: {
						'application/json': { schema: userEditableConfigSchema.partial() },
					},
				},
			},
			responses: {
				200: {
					description: 'Updated config',
					content: { 'application/json': { schema: configResponseSchema } },
				},
				404: {
					description: 'Workspace not found',
					content: { 'application/json': { schema: errorSchema } },
				},
			},
		}),
		async (c) => {
			const db = getDb(c)
			const { 'x-workspace-id': workspaceId } = c.req.valid('header')
			const patch = c.req.valid('json')

			const existing = await readSettings(db, workspaceId)
			if (!existing) {
				return c.json(errorBody('NOT_FOUND', 'Workspace not found'), 404)
			}

			const settings = existing.settings
			const customExtensions = { ...(settings.custom_extensions ?? {}) }
			const currentEntry = customExtensions[MODULE_ID] ?? {
				name: MODULE_NAME,
				types: ['meeting'],
				relationship_types: [...MEETING_RELATIONSHIP_TYPES],
				enabled: true,
			}
			const currentConfig = (currentEntry.config as Record<string, unknown> | undefined) ?? {}
			const nextConfig = { ...DEFAULT_USER_CONFIG, ...currentConfig, ...patch }

			customExtensions[MODULE_ID] = {
				...currentEntry,
				config: nextConfig,
			}

			const nextSettings = {
				...settings,
				custom_extensions: customExtensions,
			}

			await db
				.update(workspaces)
				.set({ settings: nextSettings, updatedAt: new Date() })
				.where(eq(workspaces.id, workspaceId))

			return c.json(nextConfig as z.infer<typeof configResponseSchema>, 200)
		},
	)

	return app
}
