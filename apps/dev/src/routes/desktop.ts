import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, sessions } from '@maskin/db/schema'
import {
	desktopExecBodySchema,
	desktopExecResultSchema,
	desktopInputActionSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, gt, sql } from 'drizzle-orm'
import { trackDesktopFileMoved } from '../lib/analytics/file-events'
import { resolveDesktopAgent } from '../lib/desktop-access'
import {
	FETCH_FREE_HEADROOM_BYTES,
	NO_ROOM_EXIT_CODE,
	buildPutFileCommand,
	formatBytes,
} from '../lib/desktop-put-file-command'
import {
	EMPTY_EXIT_CODE,
	NOT_ALLOWED_EXIT_CODE,
	NOT_FOUND_EXIT_CODE,
	SAVE_FILE_MAX_BYTES,
	SAVE_FILE_MAX_PER_HOUR,
	TOO_BIG_EXIT_CODE,
	buildSaveFileCommand,
	mimeTypeForFileName,
} from '../lib/desktop-save-file-command'
import {
	DESKTOP_SETTINGS_VERSION,
	KEYFILE_NEEDS_CHROMIUM_RESTART,
	buildApplySettingsCommand,
	buildReadSettingsCommand,
	parseKeyValueLines,
} from '../lib/desktop-settings'
import { signDesktopTicket } from '../lib/desktop-ticket'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { fileStorageKey, fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { resolveKeychainTyping } from '../lib/integrations/keychain-typing'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { insertStoredFile, recordFileCreated } from '../lib/stored-file'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import { DESKTOP_STREAM_PATH } from '../services/desktop-relay'
import {
	type WorkspaceDesktopService,
	createWorkspaceDesktopService,
} from '../services/workspace-desktop'

// Every agent has its own computer. These routes are workspace-scoped via
// X-Workspace-Id (authMiddleware has already confirmed the caller is a member of
// that workspace) and agent-scoped via `?agent_id=`:
//   • an agent calls them with its own API key and gets ITS desktop — it may omit
//     agent_id, and naming any other agent is refused (403);
//   • a person must say whose computer they mean, and may name any agent in the
//     workspace (to watch, take over or teach it).
// The rule itself lives in lib/desktop-access.ts.
type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType?: string
		workspaceRole?: string
		storageProvider: StorageProvider
		/** Set by app-factory from X-Maskin-Session-Id; ties a saved file to the session that saved it. */
		maskinSessionId?: string
		// Test seam: unit tests inject a fake instead of hitting agent-servers.
		desktopService?: WorkspaceDesktopService
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const agentQuery = z.object({
	agent_id: z.string().uuid().optional().openapi({
		description:
			'Whose computer. Required for people; an agent may omit it (it is its own) and may not name another.',
	}),
})

const connectResponseSchema = z.object({
	ticket: z.string().openapi({ description: 'One-time ticket, valid for 30 seconds' }),
	path: z.string().openapi({ example: DESKTOP_STREAM_PATH }),
	password: z.string().openapi({ description: 'VNC password for the noVNC client' }),
})

const accessResponses = {
	400: {
		description: 'agent_id missing or malformed',
		content: { 'application/json': { schema: errorSchema } },
	},
	403: {
		description: "An agent asked for another agent's computer",
		content: { 'application/json': { schema: errorSchema } },
	},
	404: {
		description: 'Desktop not available, or the agent is not in this workspace',
		content: { 'application/json': { schema: errorSchema } },
	},
} as const

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Start (if needed) and connect to an agent's computer",
	description:
		"Idempotent. Provisions the agent's desktop on first use, which can take up to a minute, and wakes it if it was suspended for being idle. Returns a one-time ticket to open the WebSocket at `path?ticket=…`.",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Ticket for the desktop stream',
			content: { 'application/json': { schema: connectResponseSchema } },
		},
		...accessResponses,
		503: { description: 'No capacity', content: { 'application/json': { schema: errorSchema } } },
	},
})

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Desktop'],
	summary: 'Which agents in the workspace have a computer, and whether it is asleep',
	description:
		'People see every agent with a computer; an agent sees only its own. Does not wake anything.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Computers',
			content: {
				'application/json': {
					schema: z.object({
						desktops: z.array(
							z.object({ agent_id: z.string().uuid(), status: z.enum(['running', 'suspended']) }),
						),
					}),
				},
			},
		},
		404: {
			description: 'Desktop not available',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const deleteRoute = createRoute({
	method: 'delete',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Remove an agent's computer",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Removed (or there was none)',
			content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
		},
		...accessResponses,
		502: {
			description: 'No agent-server could say where the computer is, so nothing was removed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

function serviceFor(c: { get: (k: 'desktopService' | 'db') => unknown }): WorkspaceDesktopService {
	return (
		(c.get('desktopService') as WorkspaceDesktopService | undefined) ??
		createWorkspaceDesktopService(c.get('db') as Database)
	)
}

type Ctx = {
	get: (
		k:
			| 'actorId'
			| 'actorType'
			| 'db'
			| 'desktopService'
			| 'maskinSessionId'
			| 'workspaceRole'
			| 'storageProvider',
	) => unknown
	header: (name: string, value: string) => void
	req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }
	json: (body: unknown, status: number) => Response
}

type Gate = { workspaceId: string; actorId: string; agentId: string }

/**
 * The gate every desktop route passes through: the feature flag (a cost, not
 * just a UI branch — starting a desktop provisions a multi-GB microVM), then
 * whose computer this is and whether the caller may reach it.
 *
 * `write` is true for everything except listing ports. Connecting hands out the
 * VNC password, and input/exec/delete act on the machine, so a read-only viewer
 * (a workspace member) must not get through.
 */
async function gate(c: Ctx, { write = true }: { write?: boolean } = {}): Promise<Gate | Response> {
	if (write) assertWorkspaceWriterRole(c.get('workspaceRole') as string | undefined)
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId') as string
	const access = await resolveDesktopAgent(c.get('db') as Database, {
		actorId,
		actorType: c.get('actorType') as string | undefined,
		workspaceId,
		requestedAgentId: c.req.query('agent_id'),
	})
	if (!access.ok) {
		const code =
			access.status === 400 ? 'BAD_REQUEST' : access.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND'
		return c.json(createApiError(code, access.message), access.status)
	}
	return { workspaceId, actorId, agentId: access.agentId }
}

const isResponse = (value: Gate | Response): value is Response => value instanceof Response

app.openapi(connectRoute, async (c) => {
	const gated = await gate(c as unknown as Ctx)
	if (isResponse(gated)) return gated as never
	const { workspaceId, actorId, agentId } = gated

	let located: Awaited<ReturnType<WorkspaceDesktopService['ensure']>>
	try {
		located = await serviceFor(c).ensure(workspaceId, agentId)
	} catch (err) {
		logger.error('desktop ensure failed', { workspaceId, agentId, error: String(err) })
		located = null
	}
	if (!located) {
		return c.json(createApiError('INTERNAL_ERROR', 'No desktop could be started'), 503)
	}

	if (located.created) {
		await recordEvent(c.get('db'), {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId, agent_server_id: located.server.id },
		}).catch((err) => logger.warn('desktop created event failed', { error: String(err) }))
	}

	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			ticket: signDesktopTicket({ workspaceId, actorId, agentId }),
			path: DESKTOP_STREAM_PATH,
			password: located.password,
		},
		200,
	)
})

app.openapi(listRoute, async (c) => {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId')
	let desktops = await serviceFor(c)
		.list(workspaceId)
		.catch((err) => {
			logger.warn('desktop list failed', { workspaceId, error: String(err) })
			return []
		})
	// An agent sees only its own computer, never that there are colleagues' ones.
	if (c.get('actorType') === 'agent') {
		desktops = desktops.filter((d) => d.agentId === actorId.toLowerCase())
	}
	c.header('Cache-Control', 'no-store')
	return c.json({ desktops: desktops.map((d) => ({ agent_id: d.agentId, status: d.status })) }, 200)
})

app.openapi(deleteRoute, async (c) => {
	const gated = await gate(c as unknown as Ctx)
	if (isResponse(gated)) return gated as never
	const { workspaceId, actorId, agentId } = gated
	let removed: boolean
	try {
		removed = await serviceFor(c).remove(workspaceId, agentId)
	} catch (err) {
		logger.error('desktop remove failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (removed) {
		await recordEvent(c.get('db'), {
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId },
		}).catch((err) => logger.warn('desktop deleted event failed', { error: String(err) }))
	}
	return c.json({ removed }, 200)
})

// Agent control. Same flag + access boundary as /connect: agents call these
// through the Maskin MCP with their API key, so the desktop is shared with the
// humans who are watching it over /stream and can take over at any time.

const controlResponses = {
	...accessResponses,
	502: {
		description: 'Desktop could not be reached',
		content: { 'application/json': { schema: errorSchema } },
	},
} as const

const screenshotRoute = createRoute({
	method: 'post',
	path: '/screenshot',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Screenshot of an agent's desktop",
	description: 'Starts the desktop if needed. Returns a base64 JPEG of the 1920x1080 screen.',
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Screenshot',
			content: {
				'application/json': {
					schema: z.object({
						image_base64: z.string(),
						mime_type: z.string(),
						width: z.number(),
						height: z.number(),
					}),
				},
			},
		},
		...controlResponses,
	},
})

const inputRoute = createRoute({
	method: 'post',
	path: '/input',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Send mouse/keyboard input to an agent's desktop",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: desktopInputActionSchema } } },
	},
	responses: {
		200: {
			description: 'Input delivered',
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
		},
		...controlResponses,
	},
})

const execRoute = createRoute({
	method: 'post',
	path: '/exec',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Run a shell command inside an agent's desktop VM",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: desktopExecBodySchema } } },
	},
	responses: {
		200: {
			description: 'Command result',
			content: { 'application/json': { schema: desktopExecResultSchema } },
		},
		...controlResponses,
	},
})

type ControlAction = 'screenshot' | 'input' | 'exec'

// What an agent is told when a saved password was not typed. Fixed text: the computer's own
// reply is never passed on, because it can sit next to the secret.
const NOT_A_PASSWORD_FIELD_MESSAGE =
	'The saved password was not typed: the focused field is not a password field, or the page could not confirm it. Nothing was typed.'
const NOT_A_PASSWORD_FIELD_HINT =
	'Click the password field, take a screenshot to see it has focus, then send the reference again. If the page shows the password as plain text, switch it back to hidden first.'
const OLD_COMPUTER_MESSAGE =
	'This computer is an older version that cannot check which field has focus, so the saved password was not typed. Nothing was typed. Ask a person to close and reopen the computer.'

/**
 * The session a call comes from, so a credential allowed for only this chat counts. Taken
 * only when it is this actor's own session in this workspace; anything else is ignored.
 */
async function ownSession(
	db: Database,
	header: string | undefined,
	workspaceId: string,
	actorId: string,
): Promise<{ sessionId?: string; conversationId?: string | null }> {
	if (!header || !z.string().uuid().safeParse(header).success) return {}
	const [row] = await db
		.select({ id: sessions.id, conversationId: sessions.conversationId })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, header),
				eq(sessions.workspaceId, workspaceId),
				eq(sessions.actorId, actorId),
			),
		)
		.limit(1)
	return row ? { sessionId: row.id, conversationId: row.conversationId } : {}
}

async function forwardControl(c: Ctx, action: ControlAction, body: unknown) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated

	// A saved login typed by reference: swap the real value in here, after the grant check,
	// so the agent never holds it. `forwarded` is what reaches the computer; `body` (what the
	// agent sent) is all that is ever logged.
	let forwarded = body
	let typedCredential: { credentialName: string; field: string } | null = null
	const typing = body as { action?: string; text?: string }
	if (action === 'input' && typing.action === 'type' && typeof typing.text === 'string') {
		const db = c.get('db') as Database
		const resolved = await resolveKeychainTyping(
			db,
			{
				workspaceId,
				actorId,
				actorType: c.get('actorType') as string | undefined,
				...(await ownSession(db, c.req.header('x-maskin-session-id'), workspaceId, actorId)),
			},
			typing.text,
		)
		if (resolved.kind === 'error') {
			const code =
				resolved.status === 400
					? 'BAD_REQUEST'
					: resolved.status === 403
						? 'FORBIDDEN'
						: 'NOT_FOUND'
			return c.json(createApiError(code, resolved.message), resolved.status)
		}
		if (resolved.kind === 'resolved') {
			// A password goes in only while a password field has focus: the computer checks
			// that itself, right before typing. An older computer does not know this action
			// and refuses it, so nothing is typed there either.
			forwarded =
				resolved.field === 'password'
					? { action: 'type_secret', text: resolved.text, require: 'password_field' }
					: { ...(body as object), text: resolved.text }
			typedCredential = { credentialName: resolved.credentialName, field: resolved.field }
		}
	}

	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c).control(workspaceId, agentId, action, forwarded)
	} catch (err) {
		logger.error('desktop control failed', { workspaceId, agentId, action, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (!result) return c.json(createApiError('NOT_FOUND', 'No desktop could be started'), 404)

	// Screenshots are reads; input and exec change the desktop everyone is watching.
	if (action !== 'screenshot' && result.status === 200) {
		await recordEvent(c.get('db') as Database, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			// Deliberately not the typed text or command: those can hold secrets.
			data: {
				agent_id: agentId,
				control: action,
				...(action === 'input' ? { input_action: (body as { action: string }).action } : {}),
				// The credential's name and which part, never its value.
				...(typedCredential
					? {
							keychain_credential: typedCredential.credentialName,
							keychain_field: typedCredential.field,
						}
					: {}),
			},
		}).catch((err) => logger.warn('desktop control event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
	// The desktop received the real value. Whatever it says back about a failed call could
	// quote it, so the agent gets a fixed message, never the downstream body.
	if (typedCredential && result.status !== 200) {
		logger.warn('desktop refused a typed saved login', {
			workspaceId,
			agentId,
			status: result.status,
		})
		const refusal = (result.body as { error?: string; message?: string } | null) ?? {}
		if (result.status === 409 && refusal.error === 'not_a_password_field') {
			return c.json(
				createApiError(
					'CONFLICT',
					NOT_A_PASSWORD_FIELD_MESSAGE,
					undefined,
					NOT_A_PASSWORD_FIELD_HINT,
				),
				409,
			)
		}
		if (result.status === 400 && refusal.message === 'unknown action') {
			return c.json(createApiError('CONFLICT', OLD_COMPUTER_MESSAGE), 409)
		}
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'The computer could not type the saved login. Nothing was shown.',
			),
			502,
		)
	}
	// Same reason on success: a desktop that echoes the typed text would hand it to the agent.
	if (typedCredential) return c.json({ ok: true }, 200)
	return c.json(result.body, result.status)
}

app.openapi(screenshotRoute, (c) => forwardControl(c as unknown as Ctx, 'screenshot', {}) as never)
app.openapi(
	inputRoute,
	(c) => forwardControl(c as unknown as Ctx, 'input', c.req.valid('json')) as never,
)
app.openapi(
	execRoute,
	(c) => forwardControl(c as unknown as Ctx, 'exec', c.req.valid('json')) as never,
)

// Putting a workspace file on the agent's computer. The computer is a separate
// machine from the agent's session, so a file can only get there over the network:
// the computer downloads it from a short-lived storage URL, which keeps the bytes
// (and the agent's API key) out of the model and out of the command log.

/** Long enough for the computer to start the download, short enough to be worthless afterwards. */
const PUT_FILE_URL_TTL_SECONDS = 10 * 60

const putFileBodySchema = z.object({
	file_id: z.string().uuid(),
	folder: z
		.string()
		.max(255)
		.regex(/^(\/|~\/)[^\0\r\n]*$/, 'Use an absolute path or one starting with ~/')
		.default('~/Downloads')
		.openapi({ description: 'Folder on the computer. Created if missing.' }),
})

const putFileResultSchema = z.object({
	path: z.string(),
	size_bytes: z.number().int(),
	sha256: z.string(),
	hash_verified: z.boolean().openapi({
		description:
			'True when the file has a stored hash and it matches. Large files have none, so only their size is checked.',
	}),
	free_space_bytes: z.number().int().openapi({
		description: 'Free space left on the computer after the file landed.',
	}),
})

const putFileRoute = createRoute({
	method: 'post',
	path: '/put-file',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Put a workspace file on an agent's computer",
	description:
		'The computer downloads the file straight from storage, so its bytes never pass through the caller. Starts the computer if needed. Overwrites a file of the same name in the folder. Takes up to two minutes, so a very large file can time out. Before downloading, files an earlier put-file placed there are removed: those over 24 hours old, and if the disk still lacks room for the file plus 1 GB, those over 1 hour old, oldest first. If there is still no room the call is refused (409) and nothing is downloaded.',
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: putFileBodySchema } } },
	},
	responses: {
		200: {
			description: 'The file is on the computer',
			content: { 'application/json': { schema: putFileResultSchema } },
		},
		...controlResponses,
		409: {
			description: 'Not enough free space on the computer, even after removing old fetched files',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

/** The file's name as a plain, safe file name: no folders, no shell or dot-file surprises. */
function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? ''
	return (
		base
			.replace(/[^A-Za-z0-9._ -]/g, '_')
			.replace(/^\.+/, '')
			.slice(0, 200) || 'file'
	)
}

/** Reports a finished or failed file move to analytics. Never throws and never waits. */
function reportFileMoved(
	gated: Gate,
	direction: 'to_computer' | 'to_maskin',
	outcome: string,
	sizeBytes: number | null,
) {
	void trackDesktopFileMoved({
		workspaceId: gated.workspaceId,
		actorId: gated.actorId,
		direction,
		outcome,
		sizeBytes,
	}).catch((err) => logger.warn('desktop file moved event failed', { error: String(err) }))
}

async function putFile(c: Ctx, input: { fileId: string; folder: string }) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated
	const db = c.get('db') as Database

	const [file] = await db
		.select({
			id: files.id,
			name: files.name,
			mimeType: files.mimeType,
			sizeBytes: files.sizeBytes,
			storageKey: files.storageKey,
			contentHash: files.contentHash,
		})
		.from(files)
		.where(and(eq(files.id, input.fileId), eq(files.workspaceId, workspaceId)))
		.limit(1)
	if (!file) return c.json(createApiError('NOT_FOUND', 'File not found'), 404)

	let url: string
	try {
		url = await (c.get('storageProvider') as StorageProvider).presignDownload(file.storageKey, {
			expiresInSeconds: PUT_FILE_URL_TTL_SECONDS,
			contentType: file.mimeType,
		})
	} catch (err) {
		logger.error('Failed to presign file for desktop', { fileId: file.id, error: String(err) })
		reportFileMoved(gated, 'to_computer', 'presign_failed', file.sizeBytes)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create download URL'), 500)
	}

	// Clears old fetched files, checks there is room, downloads, and prints the final path,
	// the sha256, the size and the free space left, one per line.
	const command = buildPutFileCommand({
		folder: input.folder,
		fileName: safeFileName(file.name),
		url,
		sizeBytes: file.sizeBytes,
	})

	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c as never).control(workspaceId, agentId, 'exec', {
			command,
			timeout_s: 120,
		})
	} catch (err) {
		logger.error('desktop put-file failed', { workspaceId, agentId, error: String(err) })
		reportFileMoved(gated, 'to_computer', 'unreachable', file.sizeBytes)
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (!result) return c.json(createApiError('NOT_FOUND', 'No desktop could be started'), 404)
	if (result.status !== 200) return c.json(result.body, result.status)

	const exec = desktopExecResultSchema.safeParse(result.body)
	if (!exec.success) {
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop gave an unexpected answer'), 502)
	}
	if (!exec.data.timed_out && exec.data.exit_code === NO_ROOM_EXIT_CODE) {
		const free = Number(exec.data.stdout.trim().split(' ')[1])
		logger.warn('desktop put-file refused: no room', { workspaceId, agentId, fileId: file.id })
		reportFileMoved(gated, 'to_computer', 'no_room', file.sizeBytes)
		return c.json(
			createApiError(
				'CONFLICT',
				`Not enough room on the computer. This file needs ${formatBytes(file.sizeBytes + FETCH_FREE_HEADROOM_BYTES)} free (its ${formatBytes(file.sizeBytes)} plus 1 GB to spare) and ${Number.isFinite(free) ? formatBytes(free) : 'too little'} is free, even after removing old fetched files. Nothing was downloaded. Delete files you no longer need on the computer, then try again.`,
			),
			409,
		)
	}
	if (exec.data.timed_out || exec.data.exit_code !== 0) {
		// The download tool may quote the signed URL back; it must never reach the caller.
		const detail = exec.data.stderr.split(url).join('<url>').trim().slice(0, 500)
		const diskFull = /no space left on device/i.test(exec.data.stderr)
		reportFileMoved(
			gated,
			'to_computer',
			exec.data.timed_out ? 'timeout' : diskFull ? 'disk_full' : 'download_failed',
			file.sizeBytes,
		)
		logger.warn('desktop put-file download failed', {
			workspaceId,
			agentId,
			fileId: file.id,
			exitCode: exec.data.exit_code,
			timedOut: exec.data.timed_out,
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				exec.data.timed_out
					? 'The download took longer than two minutes and was stopped'
					: diskFull
						? `The computer ran out of disk space while saving the file (it needs ${formatBytes(file.sizeBytes)}). Delete files you no longer need on the computer, then try again.`
						: `The computer could not download the file: ${detail || 'no error text'}`,
			),
			502,
		)
	}

	const [path, sha256, size, free] = exec.data.stdout.trim().split('\n')
	const sizeBytes = Number(size)
	const freeSpaceBytes = Number(free)
	const hashVerified = file.contentHash != null && sha256 === file.contentHash
	if (
		!path ||
		!sha256 ||
		!Number.isInteger(freeSpaceBytes) ||
		sizeBytes !== file.sizeBytes ||
		(file.contentHash != null && !hashVerified)
	) {
		reportFileMoved(gated, 'to_computer', 'mismatch', file.sizeBytes)
		logger.error('desktop put-file arrived different from the stored file', {
			workspaceId,
			agentId,
			fileId: file.id,
			expectedSize: file.sizeBytes,
			gotSize: size,
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'The file arrived on the computer with a different size or hash than the stored file',
			),
			502,
		)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'workspace_desktop',
		entityId: workspaceId,
		// The path, not the download URL: the URL is a credential.
		data: { agent_id: agentId, control: 'put_file', file_id: file.id, path },
	}).catch((err) => logger.warn('desktop put-file event failed', { error: String(err) }))
	reportFileMoved(gated, 'to_computer', 'ok', sizeBytes)
	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			path,
			size_bytes: sizeBytes,
			sha256,
			hash_verified: hashVerified,
			free_space_bytes: freeSpaceBytes,
		},
		200,
	)
}

app.openapi(
	putFileRoute,
	(c) =>
		putFile(c as unknown as Ctx, {
			fileId: c.req.valid('json').file_id,
			folder: c.req.valid('json').folder,
		}) as never,
)

// Keeping a running computer's settings current. A computer keeps the image it was created
// from until it is deleted and re-opened, and that wipes its saved logins, so a setting baked
// into the image (the file chooser's size) never reaches a computer that already exists. These
// two routes send a server-built command through the same exec path put-file uses: one
// rewrites a fixed list of user settings files (lib/desktop-settings.ts), one only reads.

const SETTINGS_COMMAND_TIMEOUT_S = 30

const applySettingsResultSchema = z.object({
	settings_version: z
		.number()
		.int()
		.openapi({ description: 'The settings version now on the computer' }),
	changed: z.boolean().openapi({
		description: 'False when the computer already had these settings, so nothing was written',
	}),
	chromium_restart_needed: z.boolean().openapi({
		description:
			'True when a setting only takes effect after Chromium restarts. Nothing is restarted for you: a restart closes the open pages.',
	}),
})

const applySettingsRoute = createRoute({
	method: 'post',
	path: '/apply-settings',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Bring a running computer's settings files up to date",
	description:
		"Rewrites a fixed list of user settings files on the computer (the file chooser's size and position) without deleting it, so saved logins and open pages stay. Nothing outside that list is touched. Running it again changes nothing. Starts the computer if needed.",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'The computer has the current settings',
			content: { 'application/json': { schema: applySettingsResultSchema } },
		},
		...controlResponses,
	},
})

const readSettingsResultSchema = z.object({
	status: z.enum(['running', 'suspended']),
	current_settings_version: z
		.number()
		.int()
		.openapi({ description: 'The version apply-settings would write' }),
	settings_version: z.number().int().nullable().openapi({
		description: 'The version on the computer. Null: apply-settings has never run on it.',
	}),
	image_tag: z.string().nullable().openapi({
		description:
			'The image the computer was created from. Null: it was built before images carried a tag, or the computer is asleep.',
	}),
	chooser_size: z.string().nullable(),
	chooser_position: z.string().nullable(),
	disk_total_mb: z.number().int().nullable(),
	disk_free_mb: z.number().int().nullable(),
	snapshots: z
		.object({ enabled: z.boolean(), idle_minutes: z.number().int().nullable() })
		.nullable()
		.openapi({
			description:
				'Whether an idle computer is suspended to a snapshot, and after how many minutes. Null: the host did not say.',
		}),
	new_computer_image: z.string().nullable().openapi({
		description: 'The image a new computer on this host is created from, not what this one runs',
	}),
})

const readSettingsRoute = createRoute({
	method: 'get',
	path: '/settings',
	tags: ['Desktop'],
	summary: "Read a computer's image tag, settings version, free disk and snapshot setting",
	description:
		'Read only: writes nothing and does not start the computer. A computer that is asleep answers with what the host knows and nulls for the rest, because reading the rest would wake it.',
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'What the computer and its host report',
			content: { 'application/json': { schema: readSettingsResultSchema } },
		},
		...controlResponses,
	},
})

/** Runs one fixed command on the computer. The answer is the parsed exec result, or the response to send instead. */
async function runSettingsCommand(
	c: Ctx,
	scope: { workspaceId: string; agentId: string },
	command: string,
	what: string,
) {
	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c as never).control(scope.workspaceId, scope.agentId, 'exec', {
			command,
			timeout_s: SETTINGS_COMMAND_TIMEOUT_S,
		})
	} catch (err) {
		logger.error(`desktop ${what} failed`, { ...scope, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (!result) return c.json(createApiError('NOT_FOUND', 'No desktop could be started'), 404)
	if (result.status !== 200) return c.json(result.body, result.status)
	const exec = desktopExecResultSchema.safeParse(result.body)
	if (!exec.success) {
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop gave an unexpected answer'), 502)
	}
	if (exec.data.timed_out || exec.data.exit_code !== 0) {
		logger.warn(`desktop ${what} command failed`, {
			...scope,
			exitCode: exec.data.exit_code,
			timedOut: exec.data.timed_out,
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				exec.data.timed_out
					? 'The computer took too long and the command was stopped'
					: `The computer could not run it: ${exec.data.stderr.trim().slice(0, 500) || 'no error text'}`,
			),
			502,
		)
	}
	return exec.data
}

async function applySettings(c: Ctx) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated

	const ran = await runSettingsCommand(
		c,
		{ workspaceId, agentId },
		buildApplySettingsCommand(),
		'apply-settings',
	)
	if (ran instanceof Response) return ran

	const out = parseKeyValueLines(ran.stdout)
	const version = Number(out.settings_version)
	if (version !== DESKTOP_SETTINGS_VERSION) {
		logger.error('desktop apply-settings answered with an unexpected version', {
			workspaceId,
			agentId,
			got: out.settings_version,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop gave an unexpected answer'), 502)
	}
	const changed = out.keyfile_changed === '1' || out.marker_changed === '1'

	await recordEvent(c.get('db') as Database, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'workspace_desktop',
		entityId: workspaceId,
		data: {
			agent_id: agentId,
			control: 'apply_settings',
			settings_version: version,
			changed,
		},
	}).catch((err) => logger.warn('desktop apply-settings event failed', { error: String(err) }))
	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			settings_version: version,
			changed,
			chromium_restart_needed: KEYFILE_NEEDS_CHROMIUM_RESTART,
		},
		200,
	)
}

async function readSettings(c: Ctx) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, agentId } = gated

	// Looked up, not ensured: a read must not create a computer or wake a sleeping one.
	const located = await serviceFor(c as never)
		.locate(workspaceId, agentId)
		.catch((err) => {
			logger.warn('desktop settings lookup failed', { workspaceId, agentId, error: String(err) })
			return null
		})
	if (!located) {
		return c.json(createApiError('NOT_FOUND', 'This agent has no computer yet'), 404)
	}

	const status = located.status === 'suspended' ? 'suspended' : 'running'
	let reported: Record<string, string> = {}
	if (status === 'running') {
		const ran = await runSettingsCommand(
			c,
			{ workspaceId, agentId },
			buildReadSettingsCommand(),
			'read-settings',
		)
		if (ran instanceof Response) return ran
		reported = parseKeyValueLines(ran.stdout)
	}
	const text = (key: string) => reported[key] || null
	const whole = (key: string) => {
		const n = Number.parseInt(reported[key] ?? '', 10)
		return Number.isFinite(n) ? n : null
	}
	const snapshots = located.host?.snapshots
	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			status,
			current_settings_version: DESKTOP_SETTINGS_VERSION,
			settings_version: whole('settings_version'),
			image_tag: text('image_tag'),
			chooser_size: text('chooser_size'),
			chooser_position: text('chooser_position'),
			disk_total_mb: whole('disk_total_mb'),
			disk_free_mb: whole('disk_free_mb'),
			snapshots: snapshots
				? { enabled: snapshots.enabled, idle_minutes: snapshots.idleMinutes }
				: null,
			new_computer_image: located.host?.newComputerImage ?? null,
		},
		200,
	)
}

app.openapi(applySettingsRoute, (c) => applySettings(c as unknown as Ctx) as never)
app.openapi(readSettingsRoute, (c) => readSettings(c as unknown as Ctx) as never)

// Saving a file from the agent's computer into the workspace: the mirror of put-file. The
// computer sends the bytes straight to one short-lived storage URL the server signed for a
// key the server chose, so the bytes (and the agent's API key) never pass through the caller.

const saveFileBodySchema = z.object({
	path: z
		.string()
		.min(1)
		.max(1024)
		.regex(/^(\/|~\/)[^\0\r\n]*$/, 'Use an absolute path or one starting with ~/')
		.openapi({ description: 'Path of a file under your home folder on the computer.' }),
	name: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.openapi({ description: 'Name for the new workspace file. Defaults to the file name.' }),
})

const saveFileResultSchema = z.object({
	file_id: z.string().uuid(),
	name: z.string(),
	size_bytes: z.number().int(),
	sha256: z.string(),
	url: z.string().openapi({ description: 'Where a person opens the file in the app.' }),
})

const saveFileRoute = createRoute({
	method: 'post',
	path: '/save-file',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Save a file from an agent's computer into the workspace",
	description: `The computer sends the file straight to storage, so its bytes never pass through the caller. Always makes a new file; never overwrites one. Only a regular file under the computer's home folder, outside hidden folders, up to ${SAVE_FILE_MAX_BYTES / (1024 * 1024)} MB, and at most ${SAVE_FILE_MAX_PER_HOUR} saves per computer per hour. On any failure the stored copy is deleted and no file is made.`,
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: saveFileBodySchema } } },
	},
	responses: {
		201: {
			description: 'The file is saved',
			content: { 'application/json': { schema: saveFileResultSchema } },
		},
		...controlResponses,
		400: {
			description: 'The path is not allowed, the file is empty, or it is over the size cap',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'No regular file at the path',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Too many saves from this computer in the last hour',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

/** Saves from this computer in the last hour, counted from the audit trail every save writes. */
async function savesInLastHour(db: Database, workspaceId: string, agentId: string) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'workspace_desktop'),
				eq(events.entityId, workspaceId),
				sql`${events.data}->>'control' = 'save_file'`,
				sql`${events.data}->>'agent_id' = ${agentId}`,
				gt(events.createdAt, sql`now() - interval '1 hour'`),
			),
		)
	return row?.n ?? 0
}

async function saveFile(c: Ctx, input: { path: string; name?: string }) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated
	const db = c.get('db') as Database
	const storage = c.get('storageProvider') as StorageProvider

	// Before any side effect: a missing FRONTEND_URL would otherwise fail after the upload.
	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'File URL not configured'), 500)
	}

	if ((await savesInLastHour(db, workspaceId, agentId)) >= SAVE_FILE_MAX_PER_HOUR) {
		reportFileMoved(gated, 'to_maskin', 'rate_limited', null)
		return c.json(
			createApiError(
				'RATE_LIMITED',
				`This computer has already saved ${SAVE_FILE_MAX_PER_HOUR} files in the last hour. Save fewer, larger files (zip several together), or try again later.`,
			),
			429,
		)
	}

	// The server makes the key, under the caller's workspace. The caller never names one.
	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	let url: string
	try {
		url = await storage.presignUpload(storageKey, PUT_FILE_URL_TTL_SECONDS)
	} catch (err) {
		logger.error('Failed to presign an upload for desktop', { fileId, error: String(err) })
		reportFileMoved(gated, 'to_maskin', 'presign_failed', null)
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create upload URL'), 500)
	}

	// Anything below that goes wrong may have left bytes behind: remove them before answering.
	const discard = () =>
		storage.delete(storageKey).catch((err) =>
			logger.error('Failed to delete the object of a failed desktop save (orphan left)', {
				storageKey,
				error: String(err),
			}),
		)
	const failed = async (
		outcome: string,
		size: number | null,
		status: 500 | 502,
		message: string,
	) => {
		await discard()
		reportFileMoved(gated, 'to_maskin', outcome, size)
		return c.json(createApiError('INTERNAL_ERROR', message), status)
	}

	const command = buildSaveFileCommand({ path: input.path, url, maxBytes: SAVE_FILE_MAX_BYTES })
	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c as never).control(workspaceId, agentId, 'exec', {
			command,
			timeout_s: 120,
		})
	} catch (err) {
		logger.error('desktop save-file failed', { workspaceId, agentId, error: String(err) })
		return failed('unreachable', null, 502, 'Desktop could not be reached')
	}
	if (!result) {
		reportFileMoved(gated, 'to_maskin', 'unreachable', null)
		return c.json(createApiError('NOT_FOUND', 'No desktop could be started'), 404)
	}
	if (result.status !== 200) {
		await discard()
		reportFileMoved(gated, 'to_maskin', 'unreachable', null)
		return c.json(result.body, result.status)
	}

	const exec = desktopExecResultSchema.safeParse(result.body)
	if (!exec.success) {
		return failed('bad_answer', null, 502, 'Desktop gave an unexpected answer')
	}
	if (!exec.data.timed_out && exec.data.exit_code !== 0) {
		const code = exec.data.exit_code
		if (code === TOO_BIG_EXIT_CODE) {
			await discard()
			const size = Number(exec.data.stdout.trim().split(' ')[1])
			reportFileMoved(gated, 'to_maskin', 'over_cap', Number.isFinite(size) ? size : null)
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					`That file is ${Number.isFinite(size) ? formatBytes(size) : 'too big'}, over the ${formatBytes(SAVE_FILE_MAX_BYTES)} limit for saving. Nothing was uploaded. The file stays on the computer; if it came from Drive or another source you can fetch it again from there. Cut it down or split it, then save the parts.`,
				),
				400,
			)
		}
		if (code === NOT_FOUND_EXIT_CODE) {
			await discard()
			reportFileMoved(gated, 'to_maskin', 'not_found', null)
			return c.json(
				createApiError('NOT_FOUND', 'There is no file at that path on the computer'),
				404,
			)
		}
		if (code === NOT_ALLOWED_EXIT_CODE) {
			await discard()
			reportFileMoved(gated, 'to_maskin', 'not_allowed', null)
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Only files under your home folder can be saved, and not inside hidden folders (names starting with a dot). Copy the file to a normal folder such as ~/Downloads first.',
				),
				400,
			)
		}
		if (code === EMPTY_EXIT_CODE) {
			await discard()
			reportFileMoved(gated, 'to_maskin', 'empty', 0)
			return c.json(
				createApiError('VALIDATION_ERROR', 'That file is empty, so nothing was saved'),
				400,
			)
		}
	}
	if (exec.data.timed_out || exec.data.exit_code !== 0) {
		// The upload tool may quote the signed URL back; it must never reach the caller.
		const detail = exec.data.stderr.split(url).join('<url>').trim().slice(0, 500)
		logger.warn('desktop save-file upload failed', {
			workspaceId,
			agentId,
			exitCode: exec.data.exit_code,
			timedOut: exec.data.timed_out,
		})
		return failed(
			exec.data.timed_out ? 'timeout' : 'upload_failed',
			null,
			502,
			exec.data.timed_out
				? 'The upload took longer than two minutes and was stopped. Nothing was saved.'
				: `The computer could not upload the file: ${detail || 'no error text'}. Nothing was saved.`,
		)
	}

	const [path, size, sha256, sizeAfter] = exec.data.stdout.trim().split('\n')
	const sizeBytes = Number(size)
	if (
		!path ||
		!Number.isInteger(sizeBytes) ||
		sizeBytes <= 0 ||
		sizeBytes > SAVE_FILE_MAX_BYTES ||
		!sha256 ||
		!/^[0-9a-f]{64}$/.test(sha256) ||
		Number(sizeAfter) !== sizeBytes
	) {
		logger.error('desktop save-file gave an unusable report', {
			workspaceId,
			agentId,
			size,
			sizeAfter,
		})
		return failed(
			'bad_answer',
			Number.isFinite(sizeBytes) ? sizeBytes : null,
			502,
			'The file changed while it was being uploaded, or the computer gave an unexpected answer. Nothing was saved. Finish writing the file, then save it again.',
		)
	}

	// Trust the stored object, not the computer's word for it.
	let stored: { size: number } | null
	try {
		stored = await storage.headObject(storageKey)
	} catch (err) {
		logger.error('Failed to read the object of a desktop save', { storageKey, error: String(err) })
		return failed(
			'verify_failed',
			sizeBytes,
			500,
			'Failed to verify the upload. Nothing was saved.',
		)
	}
	if (!stored || stored.size !== sizeBytes) {
		logger.error('desktop save-file stored a different size than the computer reported', {
			workspaceId,
			agentId,
			reported: sizeBytes,
			stored: stored?.size ?? null,
		})
		return failed(
			'mismatch',
			sizeBytes,
			502,
			'The stored file does not match the size the computer reported. Nothing was saved.',
		)
	}

	const name = safeFileName(input.name ?? path)
	let created: typeof files.$inferSelect
	try {
		created = await insertStoredFile(db, {
			id: fileId,
			workspaceId,
			name,
			description: null,
			kind: null,
			tags: [],
			mimeType: mimeTypeForFileName(name),
			sizeBytes: stored.size,
			storageKey,
			// The hash the computer reported; the server did not read the bytes back.
			contentHash: sha256,
			createdBy: actorId,
		})
	} catch (err) {
		logger.error('Failed to create the file row for a desktop save', { fileId, error: String(err) })
		return failed('record_failed', sizeBytes, 500, 'Failed to create the file. Nothing was saved.')
	}

	await recordFileCreated(db, {
		file: created,
		actorId,
		sessionId: c.get('maskinSessionId') as string | undefined,
	}).catch((err) =>
		logger.error('Failed to record file created audit event', { fileId, error: String(err) }),
	)
	// Also what the hourly limit counts. The path, never the upload URL: the URL is a credential.
	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'updated',
		entityType: 'workspace_desktop',
		entityId: workspaceId,
		data: { agent_id: agentId, control: 'save_file', file_id: created.id, path },
	}).catch((err) => logger.warn('desktop save-file event failed', { error: String(err) }))
	reportFileMoved(gated, 'to_maskin', 'ok', sizeBytes)
	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			file_id: created.id,
			name: created.name,
			size_bytes: created.sizeBytes,
			sha256,
			url: fileViewerUrl(frontendUrl, workspaceId, created.id),
		},
		201,
	)
}

app.openapi(
	saveFileRoute,
	(c) =>
		saveFile(c as unknown as Ctx, {
			path: c.req.valid('json').path,
			name: c.req.valid('json').name,
		}) as never,
)

// Dev servers an agent's computer can open. The agent starts a server in its own
// session sandbox and asks for a URL its computer's browser can use. The relay
// port comes from the computer's own block on the agent-server; the caller never
// names a host port.

const portSchema = z.object({
	guest_port: z.number().int(),
	relay_port: z.number().int(),
	url: z.string().openapi({ example: 'http://host.microsandbox.internal:20003' }),
})

const exposePortRoute = createRoute({
	method: 'post',
	path: '/ports',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Open a port in the agent's session sandbox from its computer",
	description:
		"Idempotent per (session, port). Returns a URL the computer's browser can open. The session must be the agent's own and running on the same server as its computer.",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						session_id: z.string().uuid(),
						guest_port: z.number().int().min(1).max(65535),
					}),
				},
			},
		},
	},
	responses: {
		200: { description: 'Exposed', content: { 'application/json': { schema: portSchema } } },
		...controlResponses,
		503: {
			description: 'No desktop could be started',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Session not running here, no free port, or the computer cannot be given one',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const listPortsRoute = createRoute({
	method: 'get',
	path: '/ports',
	tags: ['Desktop'],
	summary: "Ports currently open from the agent's computer",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Open ports',
			content: {
				'application/json': {
					schema: z.object({ ports: z.array(portSchema.extend({ session_id: z.string() })) }),
				},
			},
		},
		...controlResponses,
	},
})

const closePortRoute = createRoute({
	method: 'delete',
	path: '/ports/{relay_port}',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: 'Close an open port to free a slot',
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		params: z.object({ relay_port: z.coerce.number().int().min(1).max(65535) }),
	},
	responses: {
		200: {
			description: 'Closed (or it was not open)',
			content: { 'application/json': { schema: z.object({ closed: z.boolean() }) } },
		},
		...controlResponses,
	},
})

const LIVE_SESSION_STATUSES = new Set(['starting', 'running', 'waiting_for_input'])

async function exposePort(c: Ctx, input: { sessionId: string; guestPort: number }) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated
	const { sessionId, guestPort } = input
	const db = c.get('db') as Database

	const [session] = await db
		.select({
			id: sessions.id,
			actorId: sessions.actorId,
			workspaceId: sessions.workspaceId,
			status: sessions.status,
			agentServerId: sessions.agentServerId,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
	// Same answer for "not yours" and "does not exist": a session id proves nothing.
	if (!session || session.workspaceId !== workspaceId || session.actorId !== agentId) {
		return c.json(createApiError('NOT_FOUND', 'No such session for this agent'), 404)
	}
	if (!LIVE_SESSION_STATUSES.has(session.status)) {
		return c.json(createApiError('CONFLICT', 'That session is not running any more'), 409)
	}
	if (!session.agentServerId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'This session does not run on an agent-server, so its computer cannot reach it',
			),
			409,
		)
	}

	const service = serviceFor(c as never)
	let located: Awaited<ReturnType<WorkspaceDesktopService['ensure']>>
	try {
		located = await service.ensure(workspaceId, agentId, { preferServerId: session.agentServerId })
	} catch (err) {
		logger.error('desktop ensure failed', { workspaceId, agentId, error: String(err) })
		located = null
	}
	if (!located) return c.json(createApiError('INTERNAL_ERROR', 'No desktop could be started'), 503)
	if (located.server.id !== session.agentServerId) {
		return c.json(
			createApiError(
				'CONFLICT',
				"This agent's computer runs on a different server than this session, and a computer can only reach sessions on its own server. Start a new session to get one on the same server, or remove the computer so it is recreated next to this session.",
			),
			409,
		)
	}

	let result: Awaited<ReturnType<WorkspaceDesktopService['ports']>>
	try {
		result = await service.ports(located.server, workspaceId, agentId, {
			type: 'expose',
			sessionId,
			guestPort,
		})
	} catch (err) {
		logger.error('desktop expose port failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (result.status === 200) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId, control: 'expose_port', guest_port: guestPort },
		}).catch((err) => logger.warn('desktop expose event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
	return c.json(result.body, result.status)
}

app.openapi(
	exposePortRoute,
	(c) =>
		exposePort(c as unknown as Ctx, {
			sessionId: c.req.valid('json').session_id,
			guestPort: c.req.valid('json').guest_port,
		}) as never,
)

async function forwardPorts(
	c: Ctx,
	action: { type: 'list' } | { type: 'close'; relayPort: number },
) {
	const gated = await gate(c, { write: action.type !== 'list' })
	if (isResponse(gated)) return gated
	const { workspaceId, agentId } = gated
	const service = serviceFor(c as never)
	const located = await service.locate(workspaceId, agentId)
	if (!located) {
		// No computer yet means nothing is open; listing must not start one.
		return action.type === 'list' ? c.json({ ports: [] }, 200) : c.json({ closed: false }, 200)
	}
	try {
		const result = await service.ports(located.server, workspaceId, agentId, action)
		c.header('Cache-Control', 'no-store')
		return c.json(result.body, result.status)
	} catch (err) {
		logger.error('desktop ports failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
}

app.openapi(listPortsRoute, (c) => forwardPorts(c as unknown as Ctx, { type: 'list' }) as never)
app.openapi(
	closePortRoute,
	(c) =>
		forwardPorts(c as unknown as Ctx, {
			type: 'close',
			relayPort: c.req.valid('param').relay_port,
		}) as never,
)

export default app
