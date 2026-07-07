import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	deleteSessionDir,
	pullSessionWorkspace,
	pushSessionWorkspace,
} from '@maskin/agent-server/session-workspace'
import { deriveIdempotencyKey } from '@maskin/mcp'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdempotencyMiddleware } from '../../middleware/idempotency'
import { type IdempotencyLedgerStub, createInMemoryIdempotencyLedger } from './idempotency-fakes'

/**
 * T14 — controlled idempotency test on the S3-bounded session restore surface.
 *
 * What this proves: a snapshotted-then-restored session that replays the same
 * MCP tool call (same SESSION_ID + same method/path/body) does not double-emit
 * the side effect. The production decomposition is:
 *
 *   POST /sessions  →  pullSessionWorkspace from S3 (restore prior state)
 *   ...agent runs, MCP tools fire with derived Idempotency-Key...
 *   /sessions/:id/complete  →  pushSessionWorkspace to S3
 *   POST /sessions (again, same sessionId, same tool call)  → dedup at apps/dev
 *
 * Driven here with the real `pullSessionWorkspace` / `pushSessionWorkspace`
 * (in-memory storage), the real `deriveIdempotencyKey` (MCP SDK), and the real
 * `createIdempotencyMiddleware` (apps/dev) backed by an in-memory ledger that
 * satisfies the Drizzle surface the middleware uses. Timings are printed so
 * the bet verdict can cite p50/p95-ish numbers for S3 pull / ledger lookup /
 * session restart on this controlled path.
 */

class InMemoryStorage implements StorageProvider {
	private readonly objects = new Map<string, Buffer>()

	async put(key: string, data: Buffer | Uint8Array): Promise<void> {
		this.objects.set(key, Buffer.from(data))
	}

	async get(key: string): Promise<Buffer> {
		const v = this.objects.get(key)
		if (!v) throw new Error(`InMemoryStorage: key not found: ${key}`)
		return v
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix))
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key)
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key)
	}

	async ensureBucket(): Promise<void> {}
}

type Timings = {
	sessionRestartMs: number
	pullSessionWorkspaceMs: number
	pushSessionWorkspaceMs: number
	idempotencyLookupMaxMs: number
	idempotencyLookupCount: number
}

type Harness = {
	app: Hono
	commentCounter: { count: number }
	ledger: IdempotencyLedgerStub
	storage: InMemoryStorage
	timings: Timings
	cleanup: () => Promise<void>
}

const ACTOR_ID = 'actor-t14'
const DESTINATION_OBJECT_ID = '00000000-0000-4000-8000-000000000001'
const COMMENT_PATH = `/api/objects/${DESTINATION_OBJECT_ID}/comments`
const COMMENT_BODY = { content: 'restored session checking in' }

async function buildHarness(): Promise<Harness> {
	const storage = new InMemoryStorage()
	const commentCounter = { count: 0 }
	const timings: Timings = {
		sessionRestartMs: 0,
		pullSessionWorkspaceMs: 0,
		pushSessionWorkspaceMs: 0,
		idempotencyLookupMaxMs: 0,
		idempotencyLookupCount: 0,
	}

	const ledger = createInMemoryIdempotencyLedger({
		onLookupMs: (ms) => {
			timings.idempotencyLookupCount += 1
			if (ms > timings.idempotencyLookupMaxMs) timings.idempotencyLookupMaxMs = ms
		},
	})

	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('actorId', ACTOR_ID)
		await next()
	})
	app.use('*', createIdempotencyMiddleware(ledger.db))

	app.post(COMMENT_PATH, async (c) => {
		commentCounter.count += 1
		return c.json({ ok: true, commentId: `cmt-${commentCounter.count}` })
	})

	return {
		app,
		commentCounter,
		ledger,
		storage,
		timings,
		cleanup: async () => {
			// Nothing to clean — the middleware's cleanup timer is module-level,
			// unrefed, and fires only every hour (will not block test exit).
		},
	}
}

async function simulateSessionRestart(
	harness: Harness,
	sessionId: string,
	sessionDirFrom: string,
): Promise<string> {
	// Mirrors what apps/agent-server actually does end-to-end at /complete →
	// next POST /sessions: push, drop the local dir, then on next start pull
	// the workspace back from S3 into a fresh dir.
	const t0 = performance.now()

	const tPushStart = performance.now()
	await pushSessionWorkspace(harness.storage, sessionId, sessionDirFrom)
	harness.timings.pushSessionWorkspaceMs = performance.now() - tPushStart

	await deleteSessionDir(sessionDirFrom)

	const sessionDirTo = await mkdtemp(join(tmpdir(), 'maskin-t14-restore-'))
	const tPullStart = performance.now()
	const pull = await pullSessionWorkspace(harness.storage, sessionId, sessionDirTo)
	harness.timings.pullSessionWorkspaceMs = performance.now() - tPullStart

	harness.timings.sessionRestartMs = performance.now() - t0

	if (!pull.restored) {
		throw new Error('restore expected to find prior workspace in S3')
	}
	return sessionDirTo
}

function postCommentRequest(idempotencyKey: string): Request {
	return new Request(`http://t14.local${COMMENT_PATH}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Idempotency-Key': idempotencyKey,
		},
		body: JSON.stringify(COMMENT_BODY),
	})
}

describe('T14 — controlled idempotency on S3-bounded restore', () => {
	let harness: Harness
	let initialSessionDir: string

	beforeEach(async () => {
		harness = await buildHarness()
		initialSessionDir = await mkdtemp(join(tmpdir(), 'maskin-t14-init-'))
		vi.stubEnv('SESSION_ID', 'sess-t14')
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await harness.cleanup()
		await rm(initialSessionDir, { recursive: true, force: true })
	})

	it('sequential replay: same MCP-derived key across S3 push/pull → exactly one comment is emitted', async () => {
		const key = deriveIdempotencyKey('POST', COMMENT_PATH, COMMENT_BODY)
		if (!key) throw new Error('expected MCP-derived key; SESSION_ID stub missing?')

		// Session 1 — exercise the fresh-session path so the skeleton dirs the
		// agent harness reads (workspace/, skills/, learnings/, memory/) exist
		// before the agent makes any tool call (bet constraint #3).
		await pullSessionWorkspace(harness.storage, 'sess-t14', initialSessionDir)

		// Session 1 — agent makes the call, then writes some workspace state.
		const res1 = await harness.app.request(postCommentRequest(key))
		expect(res1.status).toBe(200)
		const body1 = (await res1.json()) as { commentId: string }
		expect(body1.commentId).toBe('cmt-1')

		await writeFile(
			join(initialSessionDir, 'workspace', 'state.json'),
			JSON.stringify({ lastCommentId: body1.commentId }),
		)

		// Session 1 completes; session 2 restores from S3 with the same sessionId.
		const sessionDirRestored = await simulateSessionRestart(harness, 'sess-t14', initialSessionDir)

		try {
			// Restored agent re-derives the SAME key — same SESSION_ID env, same call.
			const key2 = deriveIdempotencyKey('POST', COMMENT_PATH, COMMENT_BODY)
			expect(key2).toBe(key)

			const res2 = await harness.app.request(postCommentRequest(key))
			expect(res2.status).toBe(200)
			const body2 = (await res2.json()) as { commentId: string }
			// Replayed response — same commentId, handler did NOT run again.
			expect(body2.commentId).toBe('cmt-1')
			expect(harness.commentCounter.count).toBe(1)
		} finally {
			await rm(sessionDirRestored, { recursive: true, force: true })
		}

		// Emit timings so CI logs + the bet verdict can cite numbers.
		console.log(
			'[T14 sequential]',
			JSON.stringify({
				sessionRestartMs: round(harness.timings.sessionRestartMs),
				pushSessionWorkspaceMs: round(harness.timings.pushSessionWorkspaceMs),
				pullSessionWorkspaceMs: round(harness.timings.pullSessionWorkspaceMs),
				idempotencyLookupMaxMs: round(harness.timings.idempotencyLookupMaxMs),
				idempotencyLookupCount: harness.timings.idempotencyLookupCount,
				emittedComments: harness.commentCounter.count,
			}),
		)
	})

	it('parallel replay (race shape): two concurrent posts with the same MCP-derived key — single ledger row, but handler may double-fire (documented middleware race)', async () => {
		const key = deriveIdempotencyKey('POST', COMMENT_PATH, COMMENT_BODY)
		if (!key) throw new Error('expected MCP-derived key; SESSION_ID stub missing?')

		// Both requests start before either has written to the ledger — this is
		// the snapshot+queue concurrency shape the bet flags (a retry firing
		// while the original is still in-flight).
		const [res1, res2] = await Promise.all([
			harness.app.request(postCommentRequest(key)),
			harness.app.request(postCommentRequest(key)),
		])
		expect(res1.status).toBe(200)
		expect(res2.status).toBe(200)

		// The ledger collapses to a single row (onConflictDoUpdate), so the next
		// retry beyond this race will dedup correctly.
		expect(harness.ledger.size()).toBe(1)

		// Handler execution under concurrent first-call: per the middleware's
		// own documented race (`apps/dev/src/middleware/idempotency.ts` doc
		// comment), both can run because the cache lookup happens before any
		// ledger write. We assert the OBSERVED behaviour rather than the
		// idealised one — the brief asks for failure modes to be reported, not
		// hidden.
		const handlerCalls = harness.commentCounter.count
		expect([1, 2]).toContain(handlerCalls)

		console.log(
			'[T14 parallel]',
			JSON.stringify({
				emittedComments: handlerCalls,
				ledgerRowsAfterRace: harness.ledger.size(),
				idempotencyLookupMaxMs: round(harness.timings.idempotencyLookupMaxMs),
				idempotencyLookupCount: harness.timings.idempotencyLookupCount,
				note:
					handlerCalls === 2
						? 'race observed — concurrent first-call double-emits; serialised retries dedup'
						: 'race not observed in this run — scheduling collapsed the lookup race',
			}),
		)
	})

	it('sequential replay after the race: a third call (post-ledger-write) is deduped regardless of the race outcome', async () => {
		const key = deriveIdempotencyKey('POST', COMMENT_PATH, COMMENT_BODY)
		if (!key) throw new Error('expected MCP-derived key; SESSION_ID stub missing?')

		await Promise.all([
			harness.app.request(postCommentRequest(key)),
			harness.app.request(postCommentRequest(key)),
		])
		const handlerCallsAfterRace = harness.commentCounter.count

		// A serialised retry (what the queue+retry layer T12 will actually
		// fire) MUST see the ledger row written by the race winners and
		// short-circuit.
		const res3 = await harness.app.request(postCommentRequest(key))
		expect(res3.status).toBe(200)
		expect(harness.commentCounter.count).toBe(handlerCallsAfterRace)
	})
})

function round(ms: number): number {
	return Math.round(ms * 1000) / 1000
}
