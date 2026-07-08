import { randomUUID } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	createWorkspaceSkillSchema,
	parseSkillMd,
	serializeSkillMd,
	skillNameSchema,
	updateWorkspaceSkillSchema,
} from '@maskin/shared'
import AdmZip from 'adm-zip'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { and, asc, desc, eq } from 'drizzle-orm'
import { buildCreatedAtCursorConditions, useKeysetSeek } from '../lib/cursor-pagination'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import {
	SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES,
	type SkillBundleError,
	extractSkillBundle,
} from '../lib/skill-bundles'
import { type AgentStorageManager, workspaceSkillKey } from '../services/agent-storage'

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

function isUniqueViolation(err: unknown, constraintName: string): boolean {
	// Drizzle wraps the driver's PostgresError as `err.cause`, so inspect both
	// the top-level error and its `cause` chain before giving up.
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === constraintName) return true
			if (typeof e.message === 'string' && e.message.includes(constraintName)) return true
		}
		current = e.cause
	}
	return false
}

async function requireWorkspaceMember(db: Database, workspaceId: string, actorId: string) {
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	return member ?? null
}

// -- Response schemas --

const workspaceSkillListItemSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable(),
	storageKey: z.string(),
	sizeBytes: z.number().int().nonnegative(),
	isValid: z.boolean(),
	isFolder: z.boolean(),
	fileCount: z.number().int().nonnegative().nullable(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

const workspaceSkillDetailSchema = workspaceSkillListItemSchema.extend({
	content: z.string(),
})

// The upload endpoint persists malformed bundles with `isValid: false` so the
// UI's AlertTriangle pattern can surface them. The structured `error` echoes
// the parse failure so the client can render a useful message inline without
// re-running zip validation.
const workspaceSkillUploadResponseSchema = workspaceSkillDetailSchema.extend({
	error: z
		.object({
			kind: z.string(),
			message: z.string(),
		})
		.nullable(),
})

const workspaceIdParam = z.object({ workspaceId: z.string().uuid() })
const workspaceIdAndNameParam = z.object({
	workspaceId: z.string().uuid(),
	name: skillNameSchema,
})

// Snapshot-consistent cursor pagination — mirrors `objectQuerySchema`.
// `limit`/`offset` stay optional so the historical "return everything" path
// remains the default for existing callers.
const listWorkspaceSkillsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
	order: z.enum(['asc', 'desc']).optional(),
	snapshot_at: z.string().datetime().optional(),
	cursor_created_at: z.string().datetime().optional(),
	cursor_id: z.string().uuid().optional(),
})

// -- Routes --

// GET /:workspaceId/skills — List workspace skills (without content)
const listWorkspaceSkillsRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills',
	tags: ['Workspace Skills'],
	summary: 'List workspace skills',
	request: {
		params: workspaceIdParam,
		query: listWorkspaceSkillsQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(workspaceSkillListItemSchema) } },
			description: 'Workspace skills list',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
	},
})

app.openapi(listWorkspaceSkillsRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId } = c.req.valid('param')
	const query = c.req.valid('query')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const cursorConditions = buildCreatedAtCursorConditions(
		{ createdAt: workspaceSkills.createdAt, id: workspaceSkills.id },
		query,
	)
	const listWhere = cursorConditions.length
		? and(eq(workspaceSkills.workspaceId, workspaceId), ...cursorConditions)
		: eq(workspaceSkills.workspaceId, workspaceId)

	// Historical behaviour: no ORDER BY, return every row for the workspace.
	// Under the cursor path we need a stable `(createdAt, id)` sort so the
	// keyset seek predicate agrees with the walk direction. When neither
	// `limit` nor `snapshot_at` is present the query is byte-identical to the
	// pre-scoping shape — same select, same where, no orderBy/limit/offset.
	const cursorOn = Boolean(query.snapshot_at)
	const skipOffset = useKeysetSeek(query)
	const effectiveLimit = query.limit
	const effectiveOffset = skipOffset ? undefined : query.offset

	const baseSelect = db
		.select({
			id: workspaceSkills.id,
			workspaceId: workspaceSkills.workspaceId,
			name: workspaceSkills.name,
			description: workspaceSkills.description,
			storageKey: workspaceSkills.storageKey,
			sizeBytes: workspaceSkills.sizeBytes,
			isValid: workspaceSkills.isValid,
			isFolder: workspaceSkills.isFolder,
			fileCount: workspaceSkills.fileCount,
			createdBy: workspaceSkills.createdBy,
			createdAt: workspaceSkills.createdAt,
			updatedAt: workspaceSkills.updatedAt,
		})
		.from(workspaceSkills)
		.where(listWhere)

	const rows = await (cursorOn
		? query.order === 'asc'
			? baseSelect
					.orderBy(asc(workspaceSkills.createdAt), asc(workspaceSkills.id))
					.limit(effectiveLimit ?? 100)
					.offset(effectiveOffset ?? 0)
			: baseSelect
					.orderBy(desc(workspaceSkills.createdAt), asc(workspaceSkills.id))
					.limit(effectiveLimit ?? 100)
					.offset(effectiveOffset ?? 0)
		: effectiveLimit !== undefined
			? baseSelect.limit(effectiveLimit).offset(effectiveOffset ?? 0)
			: baseSelect)

	return c.json(serializeArray(rows) as z.infer<typeof workspaceSkillListItemSchema>[], 200)
}) as RouteHandler<typeof listWorkspaceSkillsRoute, Env>)

// GET /:workspaceId/skills/:name — Get a skill with full content
const getWorkspaceSkillRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Get a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill details',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
	},
})

app.openapi(getWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const { workspaceId, name } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [skill] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	return c.json(serialize(skill) as z.infer<typeof workspaceSkillDetailSchema>, 200)
}) as RouteHandler<typeof getWorkspaceSkillRoute, Env>)

// POST /:workspaceId/skills — Create a new workspace skill
const createWorkspaceSkillRoute = createRoute({
	method: 'post',
	path: '/{workspaceId}/skills',
	tags: ['Workspace Skills'],
	summary: 'Create a workspace skill',
	request: {
		params: workspaceIdParam,
		body: {
			content: {
				'application/json': {
					schema: createWorkspaceSkillSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A skill with this name already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId } = c.req.valid('param')
	const body = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	// Invalid SKILL.md content is accepted so the user can land it in the UI
	// and fix the formatting. Invalid rows are flagged `is_valid=false` and
	// skipped when agent sessions pull workspace skills. `parseSkillMd` only
	// throws on malformed YAML — a file without frontmatter returns an empty
	// name, which we treat as invalid here.
	let parsed: ReturnType<typeof parseSkillMd> | null = null
	try {
		parsed = parseSkillMd(body.content)
	} catch {
		parsed = null
	}
	const description = parsed?.description ? parsed.description : null
	const isValid = parsed !== null && skillNameSchema.safeParse(parsed.name).success

	// Atomic DB + S3 create. Order: INSERT inside tx → S3 put → tx commits.
	// - Unique-name violation: caught on INSERT, S3 never touched (→ 409).
	// - S3 failure: throws inside tx, DB row rolls back; no orphan row.
	// - tx commit failure (rare): S3 holds an object under the row's UUID, but
	//   no DB row references that UUID, so it's an inert orphan (cannot be
	//   discovered or read by any code path).
	const skillId = randomUUID()
	const storageKey = workspaceSkillKey(workspaceId, skillId)
	const sizeBytes = Buffer.byteLength(body.content, 'utf-8')

	let created: typeof workspaceSkills.$inferSelect | undefined
	let s3PutSucceeded = false
	try {
		created = await db.transaction(async (tx) => {
			const rows = await tx
				.insert(workspaceSkills)
				.values({
					id: skillId,
					workspaceId,
					name: body.name,
					description,
					content: body.content,
					storageKey,
					sizeBytes,
					isValid,
					createdBy: callerActorId,
				})
				.returning()
			const row = rows[0]
			if (!row) throw new Error('INSERT returned no row')

			await storage.putWorkspaceSkill(workspaceId, skillId, body.content)
			s3PutSucceeded = true
			return row
		})
	} catch (err) {
		if (isUniqueViolation(err, 'workspace_skills_ws_name_uniq')) {
			return c.json(
				createApiError('CONFLICT', 'A skill with this name already exists in this workspace'),
				409,
			)
		}
		if (s3PutSucceeded) {
			logger.error('Orphan S3 object after workspace_skill commit failure', {
				workspaceId,
				skillId,
				storageKey,
				error: String(err),
			})
		}
		throw err
	}

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace skill'), 500)
	}

	// Audit event — do NOT include the content field (8KB NOTIFY payload cap).
	// The mutation has already succeeded; a failing audit write must not
	// translate into a 500 for the caller.
	try {
		await db.insert(events).values({
			workspaceId,
			actorId: callerActorId,
			action: 'created',
			entityType: 'workspace_skill',
			entityId: created.id,
			data: {
				id: created.id,
				name: created.name,
				description: created.description,
				sizeBytes: created.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record workspace_skill created audit event', {
			workspaceId,
			skillId: created.id,
			error: String(err),
		})
	}

	logger.info('Workspace skill created via JSON POST', {
		workspaceId,
		skillId: created.id,
		isFolder: false,
		sizeBytes: created.sizeBytes,
	})

	// Ship-metric event for the folder-skills bet — fires on BOTH the JSON path
	// and the multipart upload path so the dashboard sees every workspace_skill
	// land regardless of how the user submitted it. Fire-and-forget after commit
	// so an analytics outage cannot fail the mutation.
	void capturePosthogEvent('workspace_skill_uploaded', workspaceId, {
		workspace_id: workspaceId,
		skill_id: created.id,
		is_folder: false,
		is_valid: created.isValid,
		size_bytes: created.sizeBytes,
		actor_id: callerActorId,
	})

	return c.json(serialize(created) as z.infer<typeof workspaceSkillDetailSchema>, 201)
}) as RouteHandler<typeof createWorkspaceSkillRoute, Env>)

// POST /:workspaceId/skills/upload — Multipart upload for `.md` or `.zip` bundles.
//
// One drop-zone in the UI lands both shapes here; the server sniffs the
// filename to decide single-file vs folder path. On a NEW upload, malformed
// bundles are persisted with `isValid: false` so the existing AlertTriangle UI
// surfaces them, instead of being rejected with a 4xx. On a replace
// (?skillId=...) a malformed bundle is rejected with 400 — landing the
// placeholder would destroy the existing bundle.
const uploadWorkspaceSkillRoute = createRoute({
	method: 'post',
	path: '/{workspaceId}/skills/upload',
	tags: ['Workspace Skills'],
	summary: 'Upload a workspace skill from a single SKILL.md or a zip bundle',
	request: {
		params: workspaceIdParam,
		query: z.object({
			skillId: z.string().uuid().optional(),
			name: skillNameSchema.optional(),
		}),
		body: {
			content: {
				'multipart/form-data': {
					schema: z.object({
						file: z.any().openapi({ type: 'string', format: 'binary' }),
					}),
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: workspaceSkillUploadResponseSchema } },
			description: 'Skill uploaded (or persisted with isValid=false on a malformed bundle)',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description:
				'Invalid request — missing file, unsupported extension, oversize zip, or malformed bundle when replacing an existing skill',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Skill to replace not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A skill with this name already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

// Compressed upload cap. Mirrors imports.ts's cap so the 10MB cap covers the
// raw zip on the wire; SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES guards zip-bombs
// after extraction.
const MAX_UPLOAD_BYTES = SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES

function sanitiseDerivedName(raw: string): string {
	const lower = raw.toLowerCase()
	const collapsed = lower
		.replace(/\.zip$/, '')
		.replace(/\.md$/, '')
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return collapsed
}

function describeBundleError(err: SkillBundleError): { kind: string; message: string } {
	return { kind: err.kind, message: err.message }
}

app.openapi(uploadWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId } = c.req.valid('param')
	const { skillId: replaceSkillId, name: nameOverride } = c.req.valid('query')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const formData = await c.req.formData()
	const file = formData.get('file')
	if (!file || !(file instanceof File)) {
		return c.json(createApiError('BAD_REQUEST', 'No file provided'), 400)
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return c.json(
			createApiError('BAD_REQUEST', `Upload too large. Maximum is ${MAX_UPLOAD_BYTES} bytes.`),
			400,
		)
	}

	const filename = file.name
	const ext = filename.split('.').pop()?.toLowerCase()
	if (ext !== 'md' && ext !== 'zip') {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Unsupported file type: .${ext ?? '(none)'}`,
				[],
				'Supported formats: .md, .zip',
			),
			400,
		)
	}

	const buffer = Buffer.from(await file.arrayBuffer())
	const isFolderUpload = ext === 'zip'

	// Replace lookup happens once up front so both paths share the same row.
	let replaceRow: typeof workspaceSkills.$inferSelect | undefined
	if (replaceSkillId) {
		const [row] = await db
			.select()
			.from(workspaceSkills)
			.where(
				and(eq(workspaceSkills.id, replaceSkillId), eq(workspaceSkills.workspaceId, workspaceId)),
			)
			.limit(1)
		if (!row) {
			return c.json(createApiError('NOT_FOUND', 'Workspace skill to replace not found'), 404)
		}
		replaceRow = row
	}

	// --- Resolve content + structural validity, depending on upload shape ---
	let skillMdContent: string
	let parsedDescription: string | null = null
	let frontmatterName: string | null = null
	let fileCount: number | null = null
	let bundleEntries: { path: string; data: Buffer }[] | null = null
	let bundleError: { kind: string; message: string } | null = null

	if (isFolderUpload) {
		const result = extractSkillBundle(buffer)
		if (!result.ok) {
			logger.warn('Folder skill upload malformed', {
				workspaceId,
				filename,
				replace: Boolean(replaceRow),
				error: describeBundleError(result.error),
			})
			if (replaceRow) {
				// A replace must never destroy the existing bundle: reject the
				// malformed zip outright instead of landing the empty/invalid
				// placeholder the create path uses (which would overwrite the row
				// and clear the previous bundle's files).
				return c.json(
					createApiError('BAD_REQUEST', `Invalid skill bundle: ${result.error.message}`),
					400,
				)
			}
			bundleError = describeBundleError(result.error)
			// Land the SKILL.md row as an empty/invalid placeholder so the UI can
			// render the error inline. file_count stays 0 because we never wrote
			// any bundled file.
			skillMdContent = ''
			fileCount = 0
		} else {
			skillMdContent = result.bundle.skillMd.content
			fileCount = result.bundle.entries.length
			bundleEntries = result.bundle.entries
			try {
				const parsed = parseSkillMd(skillMdContent)
				parsedDescription = parsed.description || null
				frontmatterName = parsed.name || null
			} catch {
				// YAML failure — treat like a missing-frontmatter SKILL.md and let
				// isValid drop to false. We still write the bundle so the user can
				// fix it in the editor without re-uploading.
			}
		}
	} else {
		skillMdContent = buffer.toString('utf-8')
		try {
			const parsed = parseSkillMd(skillMdContent)
			parsedDescription = parsed.description || null
			frontmatterName = parsed.name || null
		} catch {
			// As above — accept it, mark invalid, let the UI surface it.
		}
	}

	// --- Resolve the row name ---
	// Priority: explicit query override → SKILL.md frontmatter → sanitised
	// filename. On replace, default to the existing name when nothing else
	// gives us a valid candidate (avoids accidental renames on a bundle whose
	// SKILL.md is malformed).
	const candidateName =
		nameOverride ??
		(frontmatterName && skillNameSchema.safeParse(frontmatterName).success
			? frontmatterName
			: null) ??
		sanitiseDerivedName(filename)
	const resolvedName =
		candidateName && skillNameSchema.safeParse(candidateName).success
			? candidateName
			: (replaceRow?.name ?? `skill-${randomUUID().slice(0, 8)}`)

	const isValid =
		bundleError === null &&
		frontmatterName !== null &&
		skillNameSchema.safeParse(frontmatterName).success

	const sizeBytes = Buffer.byteLength(skillMdContent, 'utf-8')
	const now = new Date()
	const skillId = replaceRow?.id ?? randomUUID()
	const storageKey = workspaceSkillKey(workspaceId, skillId)

	// --- Persist the DB row first; storage writes follow after commit. S3 is
	// not transactional, so interleaving it with the tx could roll back the row
	// while the old bundle was already deleted. Instead: commit the row, write
	// the new files, then prune stale ones last. If a storage write fails we
	// mark the row invalid so the divergence is visible and repairable by
	// re-uploading — the prior bundle's files are still intact at that point.
	let row: typeof workspaceSkills.$inferSelect | undefined
	try {
		row = await db.transaction(async (tx) => {
			let persisted: typeof workspaceSkills.$inferSelect | undefined
			if (replaceRow) {
				// Replace path: lock the row, then UPDATE in place. We do NOT change
				// `createdBy`/`createdAt` so the row keeps its provenance.
				const [locked] = await tx
					.select()
					.from(workspaceSkills)
					.where(eq(workspaceSkills.id, replaceRow.id))
					.for('update')
					.limit(1)
				if (!locked) return undefined

				const updated = await tx
					.update(workspaceSkills)
					.set({
						name: resolvedName,
						description: parsedDescription,
						content: skillMdContent,
						storageKey,
						sizeBytes,
						isValid,
						isFolder: isFolderUpload,
						fileCount,
						updatedAt: now,
					})
					.where(eq(workspaceSkills.id, replaceRow.id))
					.returning()
				persisted = updated[0]
				if (!persisted) return undefined
			} else {
				const inserted = await tx
					.insert(workspaceSkills)
					.values({
						id: skillId,
						workspaceId,
						name: resolvedName,
						description: parsedDescription,
						content: skillMdContent,
						storageKey,
						sizeBytes,
						isValid,
						isFolder: isFolderUpload,
						fileCount,
						createdBy: callerActorId,
					})
					.returning()
				persisted = inserted[0]
				if (!persisted) throw new Error('INSERT returned no row')
			}

			return persisted
		})
	} catch (err) {
		if (isUniqueViolation(err, 'workspace_skills_ws_name_uniq')) {
			return c.json(
				createApiError('CONFLICT', 'A skill with this name already exists in this workspace'),
				409,
			)
		}
		logger.error('Workspace skill upload failed', {
			workspaceId,
			skillId,
			filename,
			isFolder: isFolderUpload,
			error: String(err),
		})
		throw err
	}

	if (!row) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill to replace not found'), 404)
	}

	try {
		// SKILL.md write — present in both single-file and folder skills.
		await storage.putWorkspaceSkill(workspaceId, skillId, skillMdContent)

		// Folder skill: write every other entry under the same prefix. SKILL.md
		// itself is written by putWorkspaceSkill above so we skip it here.
		if (bundleEntries) {
			for (const entry of bundleEntries) {
				if (entry.path === 'SKILL.md') continue
				await storage.putWorkspaceSkillFile(workspaceId, skillId, entry.path, entry.data)
			}
		}

		if (replaceRow) {
			// Prune files from the prior bundle that the new one no longer contains
			// (also covers folder → single-file replaces). Runs after the new files
			// are written so a failure above leaves the old bundle intact.
			const newPaths = new Set(['SKILL.md', ...(bundleEntries?.map((e) => e.path) ?? [])])
			await storage.clearWorkspaceSkillFolder(workspaceId, replaceRow.id, {
				keepRelativePaths: newPaths,
			})
		}
	} catch (err) {
		logger.error('Workspace skill storage write failed after commit', {
			workspaceId,
			skillId,
			filename,
			isFolder: isFolderUpload,
			error: String(err),
		})
		try {
			await db
				.update(workspaceSkills)
				.set({ isValid: false, updatedAt: new Date() })
				.where(eq(workspaceSkills.id, skillId))
		} catch (markErr) {
			logger.error('Failed to mark workspace skill invalid after storage failure', {
				workspaceId,
				skillId,
				error: String(markErr),
			})
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to write skill files to storage'), 500)
	}

	// Audit event — same shape as the JSON create path so existing listeners
	// keep working. `content` is omitted to stay under the 8KB NOTIFY cap.
	try {
		await db.insert(events).values({
			workspaceId,
			actorId: callerActorId,
			action: replaceRow ? 'updated' : 'created',
			entityType: 'workspace_skill',
			entityId: row.id,
			data: {
				id: row.id,
				name: row.name,
				description: row.description,
				sizeBytes: row.sizeBytes,
				isFolder: row.isFolder,
				fileCount: row.fileCount,
			},
		})
	} catch (err) {
		logger.error('Failed to record workspace_skill upload audit event', {
			workspaceId,
			skillId: row.id,
			error: String(err),
		})
	}

	logger.info('Workspace skill uploaded', {
		workspaceId,
		skillId: row.id,
		isFolder: row.isFolder,
		fileCount: row.fileCount,
		isValid: row.isValid,
		sizeBytes: row.sizeBytes,
		replace: Boolean(replaceRow),
	})

	// Ship-metric event — the folder-skills bet's primary funnel signal.
	// Fires on every successful commit; `is_folder` lets the dashboard split
	// single-file vs folder uploads without a second query.
	void capturePosthogEvent('workspace_skill_uploaded', workspaceId, {
		workspace_id: workspaceId,
		skill_id: row.id,
		is_folder: row.isFolder,
		file_count: row.fileCount,
		is_valid: row.isValid,
		size_bytes: row.sizeBytes,
		replace: Boolean(replaceRow),
		actor_id: callerActorId,
	})

	const response = {
		...serialize(row),
		error: bundleError,
	} as z.infer<typeof workspaceSkillUploadResponseSchema>
	return c.json(response, 201)
}) as RouteHandler<typeof uploadWorkspaceSkillRoute, Env>)

// GET /:workspaceId/skills/:skillId/download — Rebuild and download the folder
// skill as a zip. Powers the Download .zip control on the settings page and is
// the user-facing escape hatch before a destructive Replace re-upload.
//
// Only valid for folder skills. Single-file skills 404 here — the existing
// `GET /:workspaceId/skills/:name` already returns the SKILL.md body.
const downloadWorkspaceSkillRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills/{skillId}/download',
	tags: ['Workspace Skills'],
	summary: 'Download a folder skill as a zip',
	request: {
		params: z.object({
			workspaceId: z.string().uuid(),
			skillId: z.string().uuid(),
		}),
	},
	responses: {
		200: {
			content: { 'application/zip': { schema: z.any() } },
			description: 'Folder skill zip',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Folder skill not found',
		},
	},
})

// RFC 5987 — encode the filename so a name with spaces or non-ASCII still lands
// as a usable download. Falls back to a sanitised ASCII filename for older
// clients via the unquoted `filename=` parameter.
function buildContentDisposition(skillName: string): string {
	const asciiFallback = skillName.replace(/[^A-Za-z0-9._-]+/g, '_')
	const utf8 = encodeURIComponent(skillName)
	return `attachment; filename="${asciiFallback}.zip"; filename*=UTF-8''${utf8}.zip`
}

app.openapi(downloadWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, skillId } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [skill] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.id, skillId), eq(workspaceSkills.workspaceId, workspaceId)))
		.limit(1)

	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	// Single-file skills aren't a bundle — the existing GET-by-name endpoint
	// already returns their SKILL.md. 404 keeps the contract tight; the UI only
	// surfaces the Download .zip control for folder skills.
	if (!skill.isFolder) {
		return c.json(createApiError('NOT_FOUND', 'Download is only available for folder skills'), 404)
	}

	const files = await storage.listWorkspaceSkillFiles(workspaceId, skillId)
	if (files.length === 0) {
		// Row says folder but the prefix is empty — possible if a prior write
		// only partially landed. Surface as 404 rather than handing back an
		// empty zip, so the user gets a clear signal instead of a corrupt
		// round-trip.
		logger.warn('Folder skill has no files in storage', { workspaceId, skillId })
		return c.json(createApiError('NOT_FOUND', 'Folder skill is empty'), 404)
	}

	// Rebuild the zip in memory. The upload path caps each bundle at
	// SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES (10MB) so the buffer here is
	// bounded by the same limit. AdmZip mirrors the parser T2 uses on
	// upload, which keeps the round-trip (download → re-upload via T2)
	// byte-identical for the entry layout.
	const zip = new AdmZip()
	for (const { relativePath, key } of files) {
		const data = await storage.getWorkspaceSkillFile(key)
		zip.addFile(relativePath, data)
	}
	const zipBuffer = zip.toBuffer()

	logger.info('Folder skill download', {
		workspaceId,
		skillId,
		name: skill.name,
		fileCount: files.length,
		sizeBytes: zipBuffer.length,
	})

	c.header('Content-Type', 'application/zip')
	c.header('Content-Disposition', buildContentDisposition(skill.name))
	c.header('Content-Length', String(zipBuffer.length))
	return c.body(zipBuffer, 200)
}) as RouteHandler<typeof downloadWorkspaceSkillRoute, Env>)

// GET /:workspaceId/skills/:skillId/files — Lightweight file listing for a
// folder skill. Powers the settings page's inline expandable file tree;
// returns relative paths and sizes so the row can render `name + size`
// without round-tripping the bundle bytes.
const workspaceSkillFileEntrySchema = z.object({
	relativePath: z.string(),
	sizeBytes: z.number().int().nonnegative(),
})

const listWorkspaceSkillFilesRoute = createRoute({
	method: 'get',
	path: '/{workspaceId}/skills/{skillId}/files',
	tags: ['Workspace Skills'],
	summary: 'List the files bundled in a folder skill',
	request: {
		params: z.object({
			workspaceId: z.string().uuid(),
			skillId: z.string().uuid(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(workspaceSkillFileEntrySchema) } },
			description: 'Folder skill file entries (relativePath + sizeBytes)',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Skill not found or not a folder skill',
		},
	},
})

app.openapi(listWorkspaceSkillFilesRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, skillId } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [skill] = await db
		.select({ id: workspaceSkills.id, isFolder: workspaceSkills.isFolder })
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.id, skillId), eq(workspaceSkills.workspaceId, workspaceId)))
		.limit(1)

	if (!skill) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	// Single-file skills don't have a bundle to enumerate — surface a clean 404
	// so the UI only calls this endpoint for folder skills.
	if (!skill.isFolder) {
		return c.json(
			createApiError('NOT_FOUND', 'File listing is only available for folder skills'),
			404,
		)
	}

	const entries = await storage.listWorkspaceSkillFilesWithSize(workspaceId, skillId)
	// Stable order so the tree doesn't shuffle between renders. SKILL.md is the
	// bundle's entry point — surface it at the top, then sort the rest
	// alphabetically (case-sensitive, so a `reference/` group stays contiguous
	// with the rest of the lowercased paths).
	entries.sort((a, b) => {
		if (a.relativePath === 'SKILL.md') return -1
		if (b.relativePath === 'SKILL.md') return 1
		return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
	})

	return c.json(entries, 200)
}) as RouteHandler<typeof listWorkspaceSkillFilesRoute, Env>)

// PUT /:workspaceId/skills/:name — Update a workspace skill's content
const updateWorkspaceSkillRoute = createRoute({
	method: 'put',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Update a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceSkillSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: workspaceSkillDetailSchema } },
			description: 'Workspace skill updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A skill with this name already exists',
		},
	},
})

app.openapi(updateWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, name } = c.req.valid('param')
	const body = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [existing] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	let parsed: ReturnType<typeof parseSkillMd> | null = null
	try {
		parsed = parseSkillMd(body.content)
	} catch {
		parsed = null
	}
	const description = parsed?.description ? parsed.description : null

	// Frontmatter/DB-name sync: whenever the content parses, rewrite the
	// SKILL.md frontmatter `name:` to match the row's name (either the new
	// rename target, or the existing name if the user edited only content).
	// This prevents the stored file from drifting away from the row identity
	// when the user submits content with a stale or mismatched `name:`.
	// Invalid content can't be re-serialised safely — store as-is and let the
	// user fix it via the UI.
	// NOTE: `serializeSkillMd` only preserves keys in `SkillFrontmatter`
	// (see `packages/shared/src/schemas/skills.ts`). Any custom/unrecognised
	// frontmatter keys on the submitted content are dropped on re-serialise.
	const finalName = body.name ?? existing.name
	const finalContent = parsed
		? serializeSkillMd({
				name: finalName,
				description: parsed.description,
				frontmatter: parsed.frontmatter,
				content: parsed.content,
			})
		: body.content

	// `finalName` is always a schema-valid name: either Zod-validated `body.name`
	// or the existing row's name (validated when the row was last written).
	// So a successful parse plus a rewrite guarantees the stored content has a
	// schema-valid frontmatter name.
	const isValid = parsed !== null

	const sizeBytes = Buffer.byteLength(finalContent, 'utf-8')
	const now = new Date()

	// Atomic DB + S3 update. Inside a tx: re-SELECT FOR UPDATE serializes
	// concurrent updaters on this row, then UPDATE runs, then S3 put runs.
	// - S3 failure: throws inside tx → UPDATE rolls back, S3 was never written
	//   (put failed), so DB and S3 stay in sync on the previous content.
	// - Concurrent delete between outer SELECT and re-SELECT: lock-acquire
	//   sees no row → return 404, S3 not touched.
	// - Per-UUID S3 key + row lock means no other writer can race the put.
	let updated: typeof workspaceSkills.$inferSelect | undefined
	try {
		updated = await db.transaction(async (tx) => {
			const [locked] = await tx
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, existing.id))
				.for('update')
				.limit(1)

			if (!locked) return undefined

			const rows = await tx
				.update(workspaceSkills)
				.set({
					name: finalName,
					content: finalContent,
					description,
					sizeBytes,
					isValid,
					updatedAt: now,
				})
				.where(eq(workspaceSkills.id, existing.id))
				.returning()
			const row = rows[0]
			if (!row) return undefined

			await storage.putWorkspaceSkill(workspaceId, existing.id, finalContent)
			return row
		})
	} catch (err) {
		if (isUniqueViolation(err, 'workspace_skills_ws_name_uniq')) {
			return c.json(
				createApiError('CONFLICT', 'A skill with this name already exists in this workspace'),
				409,
			)
		}
		throw err
	}

	if (!updated) {
		// Row vanished between outer SELECT and the row lock (concurrent delete).
		// No S3 rollback needed — the put never ran (we returned before it).
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	try {
		await db.insert(events).values({
			workspaceId,
			actorId: callerActorId,
			action: 'updated',
			entityType: 'workspace_skill',
			entityId: updated.id,
			data: {
				id: updated.id,
				name: updated.name,
				description: updated.description,
				sizeBytes: updated.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record workspace_skill updated audit event', {
			workspaceId,
			skillId: updated.id,
			error: String(err),
		})
	}

	return c.json(serialize(updated) as z.infer<typeof workspaceSkillDetailSchema>, 200)
}) as RouteHandler<typeof updateWorkspaceSkillRoute, Env>)

// DELETE /:workspaceId/skills/:name — Delete a workspace skill
const deleteWorkspaceSkillRoute = createRoute({
	method: 'delete',
	path: '/{workspaceId}/skills/{name}',
	tags: ['Workspace Skills'],
	summary: 'Delete a workspace skill',
	request: {
		params: workspaceIdAndNameParam,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Workspace skill deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a workspace member',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace skill not found',
		},
	},
})

app.openapi(deleteWorkspaceSkillRoute, (async (c) => {
	const db = c.get('db')
	const callerActorId = c.get('actorId')
	const storage = c.get('agentStorage')
	const { workspaceId, name } = c.req.valid('param')

	const member = await requireWorkspaceMember(db, workspaceId, callerActorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const [existing] = await db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, name)))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Workspace skill not found'), 404)
	}

	// DB first — cascades remove agent_skills attachments. Delete S3 second as
	// best-effort; an orphan S3 object keyed on the deleted skill's UUID is
	// inert and cannot be picked up by a future recreate (which will mint a
	// new UUID = new S3 key).
	await db.delete(workspaceSkills).where(eq(workspaceSkills.id, existing.id))

	try {
		await storage.deleteWorkspaceSkill(workspaceId, existing.id)
	} catch (err) {
		logger.error('Failed to delete workspace skill from storage (orphan object left)', {
			workspaceId,
			skillId: existing.id,
			name,
			storageKey: existing.storageKey,
			error: String(err),
		})
	}

	try {
		await db.insert(events).values({
			workspaceId,
			actorId: callerActorId,
			action: 'deleted',
			entityType: 'workspace_skill',
			entityId: existing.id,
			data: {
				id: existing.id,
				name: existing.name,
				description: existing.description,
				sizeBytes: existing.sizeBytes,
			},
		})
	} catch (err) {
		logger.error('Failed to record workspace_skill deleted audit event', {
			workspaceId,
			skillId: existing.id,
			error: String(err),
		})
	}

	return c.json({ deleted: true as const }, 200)
}) as RouteHandler<typeof deleteWorkspaceSkillRoute, Env>)

export default app
