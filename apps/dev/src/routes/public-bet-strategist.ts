import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createApiError } from '../lib/errors'
import {
	LANDING_GUESTS_ACTOR_ID,
	LANDING_GUESTS_WORKSPACE_ID,
	getWorkspaceDailyDraftCount,
} from '../lib/landing-guests'
import { logger } from '../lib/logger'
import { extractClientIp } from './public-landing-events'

// Public, no-auth endpoint for the landing-page Bet Strategist prompt bar (T3).
// Accepts a guest's raw problem statement, calls the LLM, stores the result as a
// bet_draft object in the landing_guests workspace, and returns the draft content.
//
// Rate-limit stack (outermost → innermost, first match wins):
//   1. Per-IP per-minute  — in-memory token bucket (5 tokens/min)
//   2. Workspace daily    — DB count of all bet_draft for today → 503 when tripped
//   3. Per-cookie daily   — DB count of bet_draft for this guestSessionId today
//
// The workspace daily cap is the billing guard (cross-instance, DB-backed).
// The per-minute IP bucket is a burst guard (in-process, best-effort).
// The per-cookie cap prevents a single user from burning disproportionate quota.
//
// Mounted under `/api/public/bet-strategist` and added to the auth allowlist
// in app-factory.ts.

type Env = {
	Variables: {
		db: Database
	}
}

// ---------------------------------------------------------------------------
// Config — all caps read once so tests can override process.env before import
// ---------------------------------------------------------------------------

function readCaps() {
	const rawWorkspace = Number(process.env.WORKSPACE_DAILY_DRAFT_CAP)
	const rawCookie = Number(process.env.PER_COOKIE_DRAFT_CAP)
	const rawIpDay = Number(process.env.PER_IP_DRAFT_CAP_DAY)
	return {
		workspaceDaily: Number.isFinite(rawWorkspace) && rawWorkspace > 0 ? rawWorkspace : 1_000,
		perCookie: Number.isFinite(rawCookie) && rawCookie > 0 ? rawCookie : 3,
		perIpDay: Number.isFinite(rawIpDay) && rawIpDay > 0 ? rawIpDay : 30,
	}
}

// Per-IP per-minute token bucket (5 drafts/min sustained).
const IP_BUCKET_CAPACITY = 5
const IP_BUCKET_REFILL_PER_MS = 5 / (60 * 1000)
const IP_BUCKET_MAP_CAP = 10_000

type Bucket = { tokens: number; lastSeen: number }
const ipBuckets = new Map<string, Bucket>()

function takeIpToken(ip: string, now: number): boolean {
	const existing = ipBuckets.get(ip)
	let tokens = IP_BUCKET_CAPACITY
	if (existing) {
		const elapsed = now - existing.lastSeen
		tokens = Math.min(IP_BUCKET_CAPACITY, existing.tokens + elapsed * IP_BUCKET_REFILL_PER_MS)
	}
	if (tokens < 1) {
		ipBuckets.set(ip, { tokens, lastSeen: now })
		return false
	}
	ipBuckets.set(ip, { tokens: tokens - 1, lastSeen: now })
	if (ipBuckets.size > IP_BUCKET_MAP_CAP) {
		const drop = Math.floor(IP_BUCKET_MAP_CAP * 0.1)
		let i = 0
		for (const key of ipBuckets.keys()) {
			if (i++ >= drop) break
			ipBuckets.delete(key)
		}
	}
	return true
}

// Test-only: reset the per-IP bucket between cases.
export function _resetIpBuckets(): void {
	ipBuckets.clear()
}

// ---------------------------------------------------------------------------
// LLM call — uses MASKIN_FALLBACK_OPENROUTER_KEY / MASKIN_FALLBACK_BASE_URL
// ---------------------------------------------------------------------------

const BET_STRATEGIST_SYSTEM_PROMPT = `You are a Bet Strategist for early-stage product teams. Given a user's problem statement, write a concise bet draft: a clear framing of the opportunity, who has the problem, and what a first experiment could look like. Keep it to 3–5 paragraphs, plain prose, no headers. Be direct and specific — if the idea is unclear, surface that honestly rather than padding the response.`

interface DraftResult {
	content: string
	isMalformed: boolean
}

async function generateDraft(prompt: string): Promise<DraftResult> {
	const apiKey = process.env.MASKIN_FALLBACK_OPENROUTER_KEY?.trim()
	if (!apiKey) {
		logger.warn(
			'public-bet-strategist: MASKIN_FALLBACK_OPENROUTER_KEY not set, returning error draft',
		)
		return { content: '', isMalformed: true }
	}

	const baseUrl = process.env.MASKIN_FALLBACK_BASE_URL?.trim() ?? 'https://openrouter.ai/api'
	const model =
		process.env.MASKIN_FALLBACK_SMALL_MODEL?.trim() ??
		process.env.MASKIN_FALLBACK_MODEL?.trim() ??
		'deepseek/deepseek-v4-flash'

	try {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: BET_STRATEGIST_SYSTEM_PROMPT },
					{ role: 'user', content: prompt },
				],
				max_tokens: 800,
				temperature: 0.7,
			}),
			signal: AbortSignal.timeout(30_000),
		})

		if (!response.ok) {
			logger.warn('public-bet-strategist: LLM API error', { status: response.status })
			return { content: '', isMalformed: true }
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>
		}
		const content = data.choices?.[0]?.message?.content?.trim() ?? ''
		const isMalformed = content.length < 50
		return { content, isMalformed }
	} catch (err) {
		logger.error('public-bet-strategist: LLM call failed', {
			err: err instanceof Error ? err.message : String(err),
		})
		return { content: '', isMalformed: true }
	}
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const draftsBodySchema = z.object({
	prompt: z.string().min(10).max(2000),
	guestSessionId: z.string().min(8).max(128),
})

const claimBodySchema = z.object({
	workspace_id: z.string().uuid(),
	guestSessionId: z.string().min(8).max(128).optional(),
})

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const app = new OpenAPIHono<Env>()

app.post('/drafts', async (c) => {
	let body: z.infer<typeof draftsBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = draftsBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { prompt: string (10-2000 chars), guestSessionId: string }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	const ip = extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
	const now = Date.now()
	const caps = readCaps()

	// 1. Per-IP per-minute burst guard (in-memory)
	if (!takeIpToken(ip, now)) {
		logger.info('public-bet-strategist: per-IP rate limit hit', { ip })
		c.header('Retry-After', '60')
		return c.json(
			createApiError('RATE_LIMITED', 'Too many draft requests. Try again in a minute.'),
			429,
		)
	}

	const db = c.get('db')

	// 2. Workspace daily cap — billing guard, DB-backed for cross-instance accuracy
	const workspaceCount = await getWorkspaceDailyDraftCount(db)
	if (workspaceCount >= caps.workspaceDaily) {
		logger.warn('public-bet-strategist: workspace daily cap reached', {
			count: workspaceCount,
			cap: caps.workspaceDaily,
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'Draft capacity for today has been reached. Try again tomorrow.',
			),
			503,
		)
	}

	// 3. Per-cookie (guestSessionId) daily cap
	const todayUtcMidnight = new Date()
	todayUtcMidnight.setUTCHours(0, 0, 0, 0)

	const cookieRows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				sql`${objects.metadata}->>'guestSessionId' = ${body.guestSessionId}`,
				gte(objects.createdAt, todayUtcMidnight),
			),
		)

	const cookieCount = Number(cookieRows[0]?.count ?? 0)
	if (cookieCount >= caps.perCookie) {
		logger.info('public-bet-strategist: per-cookie cap reached', {
			guestSessionId: body.guestSessionId,
			count: cookieCount,
			cap: caps.perCookie,
		})
		return c.json(
			createApiError(
				'RATE_LIMITED',
				`You've reached the daily limit of ${caps.perCookie} drafts per session.`,
			),
			429,
		)
	}

	// Generate the draft via LLM
	const draft = await generateDraft(body.prompt)

	// Persist the bet_draft object regardless of isMalformed so the kill metric
	// (admin-landing-funnel) can count both outcomes accurately.
	let objectId: string | undefined
	try {
		const inserted = await db
			.insert(objects)
			.values({
				workspaceId: LANDING_GUESTS_WORKSPACE_ID,
				type: 'bet_draft',
				title: body.prompt.slice(0, 120),
				content: draft.content,
				status: 'done',
				createdBy: LANDING_GUESTS_ACTOR_ID,
				metadata: {
					guestSessionId: body.guestSessionId,
					isMalformed: draft.isMalformed,
					ip,
				},
			})
			.returning({ id: objects.id })

		objectId = inserted[0]?.id
		logger.info('public-bet-strategist: draft created', {
			objectId,
			guestSessionId: body.guestSessionId,
			isMalformed: draft.isMalformed,
		})
	} catch (err) {
		logger.error('public-bet-strategist: failed to persist draft', {
			err: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to save draft'), 500)
	}

	return c.json({ id: objectId, content: draft.content, isMalformed: draft.isMalformed }, 200)
})

app.post('/claim', async (c) => {
	let body: z.infer<typeof claimBodySchema>
	try {
		const raw = await c.req.json()
		const parsed = claimBodySchema.safeParse(raw)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Body must be { workspace_id: string (UUID), guestSessionId?: string }',
				),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(createApiError('VALIDATION_ERROR', 'Body must be JSON'), 400)
	}

	// guestSessionId can come from cookie or request body (client may send both
	// during the post-signup flow; body takes precedence).
	const guestSessionId = body.guestSessionId ?? c.req.header('Cookie')?.match(/_gsid=([^;]+)/)?.[1]

	if (!guestSessionId) {
		return c.json({ claimed: [] })
	}

	const db = c.get('db')

	// Return any non-malformed drafts for this session so the client can
	// re-create them as bets in the user's real workspace.
	const rows = await db
		.select({ id: objects.id, title: objects.title })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				sql`${objects.metadata}->>'guestSessionId' = ${guestSessionId}`,
				sql`(${objects.metadata}->>'isMalformed')::boolean IS NOT TRUE`,
			),
		)

	logger.info('public-bet-strategist: drafts claimed', {
		guestSessionId,
		workspaceId: body.workspace_id,
		count: rows.length,
	})

	return c.json({ claimed: rows })
})

app.onError((err, c) => {
	logger.error('public-bet-strategist: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

export default app
