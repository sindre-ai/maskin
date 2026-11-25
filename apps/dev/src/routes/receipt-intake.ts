import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	installedLoops,
	marketplaceLoops,
	objects,
	receiptIntakeKeys,
	receiptIntakes,
} from '@maskin/db/schema'
import { ACCOUNTING_LOOP_SLUG } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { frontendBaseUrl } from '../lib/file-urls'
import { verifyResendSvix } from '../lib/integrations/providers/resend/svix'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { readReceiptIntakeConfig } from '../lib/receipt-intake/config'
import { processCommandUpload, processInboundEmail } from '../lib/receipt-intake/pipeline'
import {
	RECEIPT_DAILY_CAP,
	RECEIPT_MAX_BYTES,
	RECEIPT_MAX_KEYS,
	emailAddressFor,
	hashIntakeKey,
	intakeKeyFromHeader,
	mintEmailToken,
	mintIntakeKey,
	normalizeAllowedSenders,
} from '../lib/receipt-intake/policy'
import { createPipelineDeps, findIntakeBy } from '../lib/receipt-intake/store'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

// How an owner hands receipts to an accounting flow besides uploading in chat. Three surfaces:
//
//   /api/receipt-intake/:loopId...       the owner's own settings (signed in, writers only)
//   POST /api/webhooks/receipt-intake/email   Resend delivering one received email (signed by Svix)
//   POST /api/receipt-intake/upload      the command route (a receipt key, nothing else)
//
// The two public surfaces authenticate themselves and reach only the receipt intake tables and the
// one file they are allowed to add. The rules each follows are in lib/receipt-intake/pipeline.ts.

type Env = {
	Variables: {
		db: Database
		storageProvider: StorageProvider
		actorId: string
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const loopParam = z.object({ loopId: z.string().uuid() })

const statusSchema = z.object({
	email: z.object({
		available: z.boolean(),
		enabled: z.boolean(),
		address: z.string().nullable(),
		allowed_senders: z.array(z.string()),
		default_sender: z.string().nullable(),
		accepted: z.number().int(),
		held: z.number().int(),
	}),
	command: z.object({
		upload_url: z.string(),
		keys: z.array(
			z.object({
				id: z.string().uuid(),
				last4: z.string(),
				created_at: z.string(),
				last_used_at: z.string().nullable(),
			}),
		),
	}),
	limits: z.object({
		daily_cap: z.number().int(),
		max_file_bytes: z.number().int(),
		file_types: z.array(z.string()),
	}),
})
type Status = z.infer<typeof statusSchema>

/** The flow must be an installed Accounting flow in this workspace. Anything else is a 404. */
async function accountingFlowExists(db: Database, workspaceId: string, loopId: string) {
	const [row] = await db
		.select({ id: objects.id })
		.from(objects)
		.innerJoin(installedLoops, eq(installedLoops.objectId, objects.id))
		.innerJoin(marketplaceLoops, eq(marketplaceLoops.id, installedLoops.sourceLoopId))
		.where(
			and(
				eq(objects.id, loopId),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'loop'),
				eq(marketplaceLoops.slug, ACCOUNTING_LOOP_SLUG),
			),
		)
		.limit(1)
	return !!row
}

async function buildStatus(db: Database, loopId: string): Promise<Status> {
	const config = readReceiptIntakeConfig()
	const intake = await findIntakeBy(db, eq(receiptIntakes.loopObjectId, loopId))
	const [full] = intake
		? await db.select().from(receiptIntakes).where(eq(receiptIntakes.id, intake.id)).limit(1)
		: []
	const keys = full
		? await db
				.select()
				.from(receiptIntakeKeys)
				.where(and(eq(receiptIntakeKeys.intakeId, full.id), isNull(receiptIntakeKeys.revokedAt)))
				.orderBy(desc(receiptIntakeKeys.createdAt))
		: []
	let uploadUrl = '/api/receipt-intake/upload'
	try {
		uploadUrl = `${frontendBaseUrl()}/api/receipt-intake/upload`
	} catch {
		// No public URL configured (local dev): show the path.
	}
	return {
		email: {
			available: !!config,
			enabled: !!full?.emailEnabled,
			address: full && config ? emailAddressFor(full.emailToken, config.domain) : null,
			allowed_senders: full?.allowedSenders ?? [],
			default_sender: intake?.ownerEmail ?? null,
			accepted: full?.acceptedCount ?? 0,
			held: full?.heldCount ?? 0,
		},
		command: {
			upload_url: uploadUrl,
			keys: keys.map((k) => ({
				id: k.id,
				last4: k.last4,
				created_at: k.createdAt.toISOString(),
				last_used_at: k.lastUsedAt?.toISOString() ?? null,
			})),
		},
		limits: {
			daily_cap: RECEIPT_DAILY_CAP,
			max_file_bytes: RECEIPT_MAX_BYTES,
			file_types: ['PDF', 'JPEG', 'PNG', 'HEIC'],
		},
	}
}

/** The intake row for a flow, made on first use. The actor who sets it up owns the files. */
async function ensureIntake(db: Database, workspaceId: string, loopId: string, actorId: string) {
	await db
		.insert(receiptIntakes)
		.values({
			workspaceId,
			loopObjectId: loopId,
			createdBy: actorId,
			emailToken: mintEmailToken(),
		})
		.onConflictDoNothing({ target: receiptIntakes.loopObjectId })
	const [row] = await db
		.select()
		.from(receiptIntakes)
		.where(eq(receiptIntakes.loopObjectId, loopId))
		.limit(1)
	if (!row) throw new Error('receipt intake row missing after insert')
	return row
}

const jsonStatus = {
	200: { content: { 'application/json': { schema: statusSchema } }, description: 'Settings' },
	404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
}

const getStatusRoute = createRoute({
	method: 'get',
	path: '/{loopId}',
	tags: ['Receipt intake'],
	summary: 'Which ways of sending receipts are on for an Accounting flow',
	request: { headers: workspaceIdHeader, params: loopParam },
	responses: jsonStatus,
})

app.openapi(getStatusRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { loopId } = c.req.valid('param')
	if (!(await accountingFlowExists(db, workspaceId, loopId))) {
		return c.json(createApiError('NOT_FOUND', 'Not an Accounting flow'), 404)
	}
	return c.json(await buildStatus(db, loopId), 200)
}) as RouteHandler<typeof getStatusRoute, Env>)

const putEmailRoute = createRoute({
	method: 'put',
	path: '/{loopId}/email',
	'x-viewer-policy': 'writer',
	tags: ['Receipt intake'],
	summary: 'Switch the receiving email address on or off, set who may send, or make a new address',
	request: {
		headers: workspaceIdHeader,
		params: loopParam,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						enabled: z.boolean().optional(),
						allowed_senders: z.array(z.string().max(320)).max(50).optional(),
						new_address: z.boolean().optional(),
					}),
				},
			},
		},
	},
	responses: jsonStatus,
})

app.openapi(putEmailRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { loopId } = c.req.valid('param')
	const body = c.req.valid('json')
	if (!(await accountingFlowExists(db, workspaceId, loopId))) {
		return c.json(createApiError('NOT_FOUND', 'Not an Accounting flow'), 404)
	}
	if (body.enabled && !readReceiptIntakeConfig()) {
		return c.json(createApiError('NOT_FOUND', 'Email receipts are not available yet'), 404)
	}
	const intake = await ensureIntake(db, workspaceId, loopId, actorId)
	await db
		.update(receiptIntakes)
		.set({
			...(body.enabled !== undefined ? { emailEnabled: body.enabled } : {}),
			...(body.allowed_senders
				? { allowedSenders: normalizeAllowedSenders(body.allowed_senders) }
				: {}),
			// A new address makes the old one dead: mail to it is dropped like any unknown address.
			...(body.new_address ? { emailToken: mintEmailToken() } : {}),
			updatedAt: new Date(),
		})
		.where(eq(receiptIntakes.id, intake.id))
	logger.info('receipt_intake.email_changed', {
		workspace_id: workspaceId,
		intake_id: intake.id,
		enabled: body.enabled ?? null,
		rotated: !!body.new_address,
	})
	return c.json(await buildStatus(db, loopId), 200)
}) as RouteHandler<typeof putEmailRoute, Env>)

const createdKeySchema = z.object({
	id: z.string().uuid(),
	key: z.string(),
	last4: z.string(),
})

const postKeyRoute = createRoute({
	method: 'post',
	path: '/{loopId}/keys',
	'x-viewer-policy': 'writer',
	tags: ['Receipt intake'],
	summary: 'Make a key for the command route. The key is shown once.',
	request: { headers: workspaceIdHeader, params: loopParam },
	responses: {
		201: { content: { 'application/json': { schema: createdKeySchema } }, description: 'Created' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
		409: { content: { 'application/json': { schema: errorSchema } }, description: 'Too many' },
	},
})

app.openapi(postKeyRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { loopId } = c.req.valid('param')
	if (!(await accountingFlowExists(db, workspaceId, loopId))) {
		return c.json(createApiError('NOT_FOUND', 'Not an Accounting flow'), 404)
	}
	const intake = await ensureIntake(db, workspaceId, loopId, actorId)
	const [live] = await db
		.select({ n: count() })
		.from(receiptIntakeKeys)
		.where(and(eq(receiptIntakeKeys.intakeId, intake.id), isNull(receiptIntakeKeys.revokedAt)))
	if ((live?.n ?? 0) >= RECEIPT_MAX_KEYS) {
		return c.json(
			createApiError('CONFLICT', `A flow can have ${RECEIPT_MAX_KEYS} keys. Revoke one first.`),
			409,
		)
	}
	const minted = mintIntakeKey()
	const [row] = await db
		.insert(receiptIntakeKeys)
		.values({ intakeId: intake.id, keyHash: minted.hash, last4: minted.last4 })
		.returning({ id: receiptIntakeKeys.id })
	if (!row) return c.json(createApiError('INTERNAL_ERROR', 'Could not make a key'), 404)
	return c.json({ id: row.id, key: minted.key, last4: minted.last4 }, 201)
}) as RouteHandler<typeof postKeyRoute, Env>)

const deleteKeyRoute = createRoute({
	method: 'delete',
	path: '/{loopId}/keys/{keyId}',
	'x-viewer-policy': 'writer',
	tags: ['Receipt intake'],
	summary: 'Revoke a command key',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ loopId: z.string().uuid(), keyId: z.string().uuid() }),
	},
	responses: jsonStatus,
})

app.openapi(deleteKeyRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { loopId, keyId } = c.req.valid('param')
	if (!(await accountingFlowExists(db, workspaceId, loopId))) {
		return c.json(createApiError('NOT_FOUND', 'Not an Accounting flow'), 404)
	}
	const intake = await findIntakeBy(db, eq(receiptIntakes.loopObjectId, loopId))
	if (intake) {
		await db
			.update(receiptIntakeKeys)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(receiptIntakeKeys.id, keyId),
					eq(receiptIntakeKeys.intakeId, intake.id),
					isNull(receiptIntakeKeys.revokedAt),
				),
			)
	}
	return c.json(await buildStatus(db, loopId), 200)
}) as RouteHandler<typeof deleteKeyRoute, Env>)

export default app

// ── Public: Resend delivers one received email ────────────────────────────────

export const receiptWebhookApp = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const receivedWebhookSchema = z.object({
	type: z.string(),
	data: z
		.object({
			email_id: z.string().min(1).max(200),
			from: z.string().max(1000).optional(),
			to: z.array(z.string().max(1000)).max(100).optional(),
			cc: z.array(z.string().max(1000)).max(100).optional(),
		})
		.passthrough(),
})

// Not part of the OpenAPI spec: Resend calls it, and the signature is the only credential.
receiptWebhookApp.post('/receipt-intake/email', async (c) => {
	const config = readReceiptIntakeConfig()
	if (!config) return c.json({ error: 'receipt email is not set up' }, 503)

	const raw = await c.req.text()
	const headers: Record<string, string> = {}
	for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
		const v = c.req.header(name)
		if (v) headers[name] = v
	}
	if (!verifyResendSvix(raw, headers, config.webhookSecret)) {
		return c.json({ error: 'bad signature' }, 401)
	}

	let payload: z.infer<typeof receivedWebhookSchema>
	try {
		payload = receivedWebhookSchema.parse(JSON.parse(raw))
	} catch {
		// Signed but not ours to read. Answer success so it is not retried.
		return c.json({ ok: true, result: 'ignored' })
	}
	if (payload.type !== 'email.received') return c.json({ ok: true, result: 'ignored' })

	const db = c.get('db')
	try {
		const outcome = await processInboundEmail(
			createPipelineDeps(db, c.get('storageProvider'), { apiKey: config.resendApiKey }),
			{ domain: config.domain },
			{
				emailId: payload.data.email_id,
				from: payload.data.from,
				to: payload.data.to,
				cc: payload.data.cc,
			},
		)
		// Counts and reasons only. The sender, subject and file names stay out of the log.
		logger.info('receipt_intake.email', {
			result: outcome.result,
			reason: 'reason' in outcome ? outcome.reason : null,
			saved: 'saved' in outcome ? outcome.saved : 0,
		})
		return c.json({ ok: true, result: outcome.result })
	} catch (err) {
		logger.error('receipt_intake.email_failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		// A real failure (Resend or storage down): ask Resend to try again.
		return c.json({ error: 'try again' }, 500)
	}
})

// ── Public: the command route ─────────────────────────────────────────────────

export const receiptUploadApp = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// One file, one key. The key is looked up in receipt_intake_keys and nowhere else, so it can add a
// receipt to its own flow and cannot read, list, change or reach anything.
receiptUploadApp.post('/upload', async (c) => {
	const key = intakeKeyFromHeader(c.req.header('authorization'))
	if (!key) return c.json({ error: 'A receipt key is needed' }, 401)

	const db = c.get('db')
	const [row] = await db
		.select({ keyId: receiptIntakeKeys.id, intakeId: receiptIntakeKeys.intakeId })
		.from(receiptIntakeKeys)
		.where(
			and(eq(receiptIntakeKeys.keyHash, hashIntakeKey(key)), isNull(receiptIntakeKeys.revokedAt)),
		)
		.limit(1)
	if (!row) return c.json({ error: 'That receipt key is not valid' }, 401)

	const declared = Number(c.req.header('content-length') ?? 0)
	// A little more than the file cap, for the form wrapping.
	if (declared > RECEIPT_MAX_BYTES + 64 * 1024) return c.json({ error: 'File is too large' }, 413)

	const intake = await findIntakeBy(db, eq(receiptIntakes.id, row.intakeId))
	if (!intake) return c.json({ error: 'That receipt key is not valid' }, 401)

	let file: unknown
	try {
		file = (await c.req.parseBody()).file
	} catch {
		return c.json({ error: 'Send the receipt as a form with one file field named file' }, 400)
	}
	if (!(file instanceof File)) {
		return c.json({ error: 'Send the receipt as a form with one file field named file' }, 400)
	}
	if (file.size > RECEIPT_MAX_BYTES) return c.json({ error: 'File is too large' }, 413)

	const deps = createPipelineDeps(db, c.get('storageProvider'), null)
	const outcome = await processCommandUpload(deps, intake, {
		name: file.name,
		bytes: Buffer.from(await file.arrayBuffer()),
	})
	if (outcome.result === 'refused') {
		const status = outcome.reason === 'daily_cap' ? 429 : outcome.reason === 'too_large' ? 413 : 400
		return c.json({ error: refusalText(outcome.reason) }, status)
	}
	await db
		.update(receiptIntakeKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(receiptIntakeKeys.id, row.keyId))
	logger.info('receipt_intake.command', { intake_id: intake.id, result: 'saved' })
	return c.json({ ok: true, saved: 1 }, 201)
})

function refusalText(reason: 'empty' | 'too_large' | 'bad_type' | 'daily_cap'): string {
	switch (reason) {
		case 'empty':
			return 'The file is empty'
		case 'too_large':
			return 'File is too large'
		case 'bad_type':
			return 'Only PDF, JPEG, PNG and HEIC receipts are taken'
		case 'daily_cap':
			return 'The daily limit for this flow is reached. Try again tomorrow.'
	}
}
