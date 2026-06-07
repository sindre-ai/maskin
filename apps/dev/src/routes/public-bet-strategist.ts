import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { objects, sessions } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
	BET_STRATEGIST_SYSTEM_PROMPT,
	extractDraftTitle,
	isMalformedDraft,
} from '../lib/bet-strategist-prompt'
import { createApiError } from '../lib/errors'
import {
	GUEST_COOKIE_NAME,
	buildGuestCookieHeader,
	generateGuestSessionId,
	parseGuestCookie,
	signGuestSessionId,
	verifyGuestCookieValue,
} from '../lib/guest-session'
import { checkGuestThrottle } from '../lib/guest-throttle'
import { AnthropicAdapter } from '../lib/llm/anthropic'
import { logger } from '../lib/logger'
import { isWorkspaceMember } from '../lib/workspace-auth'

// Public, no-auth endpoint that powers the landing-page prompt bar. Per A1's
// ADR (Option C):
//   - HttpOnly signed cookie carries `guestSessionId`
//   - Throttle: 3 drafts per cookie + 5/min · 30/day per IP
//   - Drafts persist as objects (type=bet_draft, createdBy=LANDING_GUEST_ACTOR_ID,
//     metadata.guestSessionId)
//   - Cost flows through real `sessions` rows
//   - SSE matches apps/web/src/lib/sse.ts (data: JSON per event)
//   - Malformed-output telemetry keyed on guestSessionId for the 10%-in-48h
//     rolling kill metric.
//
// The route is added to the auth allowlist in app-factory.ts.

export const LANDING_GUEST_ACTOR_ID = '00000000-0000-0000-0001-000000000001'
export const LANDING_GUESTS_WORKSPACE_ID = '00000000-0000-0000-0001-000000000002'

const MODEL = 'claude-opus-4-7'
const MAX_PROMPT_CHARS = 4000

type Env = {
	Variables: {
		db: Database
		// Set by authMiddleware on /claim; absent on the public /drafts path
		// because that route lives in the auth allowlist.
		actorId: string
		actorType: string
	}
}

const draftBodySchema = z.object({
	prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
})

const claimBodySchema = z.object({
	workspace_id: z.string().uuid(),
})

const app = new OpenAPIHono<Env>()

app.post('/drafts', async (c) => {
	const db = c.get('db')

	let body: { prompt: string }
	try {
		const parsed = draftBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json(
				createApiError('VALIDATION_ERROR', 'prompt must be a non-empty string under 4000 chars'),
				400,
			)
		}
		body = parsed.data
	} catch {
		return c.json(
			createApiError('VALIDATION_ERROR', 'Body must be JSON with a `prompt` field'),
			400,
		)
	}

	const anthropicKey = process.env.ANTHROPIC_API_KEY
	if (!anthropicKey) {
		logger.error('public-bet-strategist: ANTHROPIC_API_KEY missing')
		return c.json(createApiError('INTERNAL_ERROR', 'Bet Strategist is unavailable'), 503)
	}

	const ip = extractClientIp(c.req.raw, c.req.header('X-Forwarded-For'))

	const cookieHeader = c.req.header('Cookie')
	const rawCookie = parseGuestCookie(cookieHeader)
	let guestSessionId: string | null = rawCookie ? verifyGuestCookieValue(rawCookie) : null
	const isFreshCookie = !guestSessionId
	if (!guestSessionId) guestSessionId = generateGuestSessionId()

	const verdict = await checkGuestThrottle(db, {
		workspaceId: LANDING_GUESTS_WORKSPACE_ID,
		guestSessionId,
		ip,
	})

	if (!verdict.allowed) {
		logger.info('public-bet-strategist: throttled', { reason: verdict.reason, guestSessionId, ip })
		c.header('Retry-After', verdict.reason === 'cookie_quota' ? '0' : '60')
		return c.json(
			createApiError('RATE_LIMITED', throttleMessage(verdict.reason), undefined, throttleHint()),
			429,
		)
	}

	const [draft] = await db
		.insert(objects)
		.values({
			workspaceId: LANDING_GUESTS_WORKSPACE_ID,
			type: 'bet_draft',
			status: 'streaming',
			title: 'Draft in progress',
			content: '',
			metadata: { guestSessionId, ip, isMalformed: false, prompt: body.prompt },
			createdBy: LANDING_GUEST_ACTOR_ID,
		})
		.returning({ id: objects.id })

	const draftId = draft?.id
	if (!draftId) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create draft'), 500)
	}

	const [session] = await db
		.insert(sessions)
		.values({
			workspaceId: LANDING_GUESTS_WORKSPACE_ID,
			actorId: LANDING_GUEST_ACTOR_ID,
			createdBy: LANDING_GUEST_ACTOR_ID,
			status: 'running',
			actionPrompt: body.prompt,
			startedAt: new Date(),
			config: { kind: 'guest_bet_strategist_draft', draftId, guestSessionId },
		})
		.returning({ id: sessions.id })

	const sessionId = session?.id

	const signed = signGuestSessionId(guestSessionId)
	const secure = (process.env.NODE_ENV ?? 'development') === 'production'
	c.header('Set-Cookie', buildGuestCookieHeader(signed, { secure }))

	logger.info('public-bet-strategist: draft started', {
		draftId,
		sessionId,
		guestSessionId,
		isFreshCookie,
	})

	const clientSignal = c.req.raw.signal

	return streamSSE(c, async (stream) => {
		const adapter = new AnthropicAdapter(anthropicKey)
		const started = Date.now()
		let buffer = ''
		let inputTokens = 0
		let outputTokens = 0
		let failed = false
		// Set only when the in-loop check observes the client signal aborted.
		// Re-reading the signal at end-of-stream would also flip true for
		// server-side aborts (timeout middleware, process shutdown), which would
		// silently exclude real failures from the rolling-kill metric.
		let clientAborted = false

		await stream.writeSSE({ event: 'draft_started', data: JSON.stringify({ draftId }) })

		try {
			for await (const chunk of adapter.chatStream({
				model: MODEL,
				system: BET_STRATEGIST_SYSTEM_PROMPT,
				userPrompt: body.prompt,
				temperature: 0.4,
				maxTokens: 1024,
				signal: clientSignal,
			})) {
				if (clientSignal?.aborted) {
					clientAborted = true
					break
				}
				if (chunk.type === 'text' && chunk.text) {
					buffer += chunk.text
					await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk.text }) })
				} else if (chunk.type === 'usage') {
					inputTokens = chunk.inputTokens ?? 0
					outputTokens = chunk.outputTokens ?? 0
				}
			}
		} catch (err) {
			if (clientAborted) {
				// Already observed the client disconnect from the in-loop check;
				// nothing more to record.
			} else {
				failed = true
				logger.error('public-bet-strategist: stream error', {
					err: err instanceof Error ? err.message : String(err),
					draftId,
				})
				try {
					await stream.writeSSE({
						event: 'error',
						data: JSON.stringify({ message: 'Stream failed' }),
					})
				} catch {}
			}
		}

		const aborted = clientAborted
		// An aborted partial isn't malformed by the LLM — exclude it from the
		// 10%-in-48h rolling-kill metric.
		const malformed = !aborted && (failed || isMalformedDraft(buffer))
		const durationMs = Date.now() - started

		await db
			.update(objects)
			.set({
				content: buffer,
				title: extractDraftTitle(buffer),
				status: failed || aborted ? 'failed' : malformed ? 'malformed' : 'completed',
				metadata: {
					guestSessionId,
					ip,
					isMalformed: malformed,
					prompt: body.prompt,
					inputTokens,
					outputTokens,
					durationMs,
					...(aborted ? { aborted: true } : {}),
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, draftId))

		if (sessionId) {
			await db
				.update(sessions)
				.set({
					status: failed || aborted ? 'failed' : 'completed',
					completedAt: new Date(),
					inputTokens,
					outputTokens,
					durationMs,
				})
				.where(eq(sessions.id, sessionId))
		}

		logger.info('public-bet-strategist: draft completed', {
			draftId,
			sessionId,
			guestSessionId,
			isMalformed: malformed,
			failed,
			aborted,
			durationMs,
			inputTokens,
			outputTokens,
		})

		if (!aborted) {
			try {
				await stream.writeSSE({
					event: 'done',
					data: JSON.stringify({ draftId, isMalformed: malformed, failed }),
				})
			} catch {}
		}
	})
})

// POST /claim
//
// Copies a guest visitor's completed bet drafts (stored in the singleton
// `landing_guests` workspace under the `landing_guest` system actor) into a
// signed-up user's workspace. Per A1's ADR: copy, no FK reparenting — the
// originals remain as an immutable telemetry record in the guests workspace.
//
// Authn: bearer-authed actor (auth middleware runs because this path is NOT
// in the allowlist — only POST /drafts is exempt).
// Authz: the actor must be a member of `workspace_id`.
// Handoff token: the HttpOnly `maskin_guest` cookie that was set by /drafts.
//   If the cookie is missing or invalid (the user didn't come from the landing
//   page), the call is a 200 no-op so the signup flow doesn't need to
//   pre-check whether there's anything to claim.
// Idempotency: the original guest draft is stamped with `metadata.claimedBy`
//   and `metadata.claimedAs`; re-claiming returns the existing bet ids
//   without inserting duplicates.
app.post('/claim', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	if (!actorId) {
		// authMiddleware should always set this for non-allowlisted routes; if
		// it's missing, the allowlist was misconfigured and we shouldn't silently
		// expose a copy endpoint.
		logger.error('public-bet-strategist/claim: actorId missing — allowlist misconfigured')
		return c.json(createApiError('UNAUTHORIZED', 'Authentication required'), 401)
	}

	let body: { workspace_id: string }
	try {
		const parsed = claimBodySchema.safeParse(await c.req.json())
		if (!parsed.success) {
			return c.json(createApiError('VALIDATION_ERROR', 'workspace_id must be a UUID'), 400)
		}
		body = parsed.data
	} catch {
		return c.json(
			createApiError('VALIDATION_ERROR', 'Body must be JSON with a `workspace_id` field'),
			400,
		)
	}

	const targetWorkspaceId = body.workspace_id

	const isMember = await isWorkspaceMember(db, actorId, targetWorkspaceId)
	if (!isMember) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of the target workspace'), 403)
	}

	const rawCookie = parseGuestCookie(c.req.header('Cookie'))
	const guestSessionId = rawCookie ? verifyGuestCookieValue(rawCookie) : null

	if (!guestSessionId) {
		// No usable guest cookie — treat as a clean signup. 200 no-op so the
		// signup flow can call claim unconditionally.
		logger.info('public-bet-strategist/claim: no guest cookie, no-op', { actorId })
		return c.json({ claimed: [] })
	}

	const candidates = await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				eq(objects.status, 'completed'),
				sql`metadata->>'guestSessionId' = ${guestSessionId}`,
			),
		)

	if (candidates.length === 0) {
		logger.info('public-bet-strategist/claim: no claimable drafts', { actorId, guestSessionId })
		return c.json({ claimed: [] })
	}

	const claimed: Array<{ id: string; title: string | null }> = []

	for (const draft of candidates) {
		const meta = (draft.metadata ?? {}) as Record<string, unknown>
		const previousClaim = meta.claimedAs as string | undefined
		if (previousClaim) {
			// Already claimed by a prior call for this session — return the same
			// id so the caller can navigate to it. Idempotent.
			claimed.push({ id: previousClaim, title: draft.title })
			continue
		}

		const [created] = await db
			.insert(objects)
			.values({
				workspaceId: targetWorkspaceId,
				type: 'bet',
				status: 'signal',
				title: draft.title ?? 'Untitled bet',
				content: draft.content ?? '',
				metadata: {
					claimedFromGuestDraft: draft.id,
					claimedFromGuestSessionId: guestSessionId,
				},
				createdBy: actorId,
			})
			.returning({ id: objects.id })

		if (!created) {
			logger.error('public-bet-strategist/claim: failed to insert claimed bet', {
				draftId: draft.id,
				actorId,
				targetWorkspaceId,
			})
			continue
		}

		await db
			.update(objects)
			.set({
				metadata: {
					...meta,
					claimedAt: new Date().toISOString(),
					claimedBy: actorId,
					claimedIntoWorkspace: targetWorkspaceId,
					claimedAs: created.id,
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, draft.id))

		claimed.push({ id: created.id, title: draft.title })
	}

	logger.info('public-bet-strategist/claim: drafts claimed', {
		actorId,
		guestSessionId,
		targetWorkspaceId,
		count: claimed.length,
	})

	return c.json({ claimed })
})

app.onError((err, c) => {
	logger.error('public-bet-strategist: unhandled error', {
		err: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	return c.json(createApiError('INTERNAL_ERROR', 'An unexpected error occurred'), 500)
})

function throttleMessage(reason: 'cookie_quota' | 'ip_rate' | 'ip_daily'): string {
	switch (reason) {
		case 'cookie_quota':
			return 'Guest quota reached. Sign up to keep drafting.'
		case 'ip_rate':
			return 'Too many drafts in the last minute. Try again shortly.'
		case 'ip_daily':
			return 'Daily limit reached for this network. Sign up to keep drafting.'
	}
}

function throttleHint(): string {
	return 'Landing-page guests can draft up to 3 bets before signing up; per-network limits apply.'
}

// X-Forwarded-For is set by our edge; fall back to socket remoteAddress in dev.
// We take the *first* hop because anything later is a chained proxy we don't trust.
function extractClientIp(req: Request, fwd: string | undefined): string {
	if (fwd) {
		const first = fwd.split(',')[0]?.trim()
		if (first) return first
	}
	// Hono Request types don't expose remoteAddress directly — env-specific.
	const remote = (req as unknown as { remoteAddress?: string }).remoteAddress
	return remote || 'unknown'
}

export { GUEST_COOKIE_NAME }
export default app
