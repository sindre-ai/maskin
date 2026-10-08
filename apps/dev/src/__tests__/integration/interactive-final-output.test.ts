import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { events, conversations, messages, sessionLogs, sessions } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import {
	InteractiveTurnFinalizer,
	type RetryTurnFn,
} from '../../services/interactive-turn-finalizer'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * The auto-posted end-of-turn reply, against real Postgres.
 *
 * The idempotency behaviour here CANNOT be verified with a mocked DB: the
 * guard is a partial unique index on a JSON expression, and the whole point of
 * the test is that the index — not the in-process cache — is what stops a
 * Docker log replay from re-posting every past turn.
 */

function resultLine(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'Here is the answer.',
		duration_ms: 1234,
		total_cost_usd: 0.42,
		usage: { input_tokens: 10, output_tokens: 20 },
		...overrides,
	})
}

/** One streamed `assistant` line carrying a single text block. */
function assistantLine(text: string, overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: 'assistant',
		message: { id: 'gen-1', role: 'assistant', content: [{ type: 'text', text }] },
		...overrides,
	})
}

/** An `assistant` line whose only block is thinking — the trailing block that blanks `result`. */
function thinkingLine(thinking: string) {
	return JSON.stringify({
		type: 'assistant',
		message: { id: 'gen-1', role: 'assistant', content: [{ type: 'thinking', thinking }] },
	})
}

/** An `assistant` line whose only block is a call to the named tool. */
function toolUseLine(name: string) {
	return JSON.stringify({
		type: 'assistant',
		message: {
			id: 'gen-1',
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }],
		},
	})
}

/** The untagged `user` envelope the CLI writes to feed a tool's output back to the model. */
function toolResultLine() {
	return JSON.stringify({
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
		},
	})
}

/** The `system` init line the CLI prints first, carrying the model the session runs on. */
function initLine(model: string) {
	return JSON.stringify({ type: 'system', subtype: 'init', model })
}

/** The user-turn envelope SessionManager.writeInput persists — the turn boundary. */
function userTurnLine(messageId: number) {
	return JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hello' },
		maskin_message_id: messageId,
	})
}

describe('Interactive turn finalizer', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string
	let finalizer: InteractiveTurnFinalizer

	async function seedSession(overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
			...overrides,
		})
	}

	/** Persists a log row the way the ingest path does, then feeds the finalizer. */
	async function feed(sessionId: string, content: string) {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await finalizer.onStdout(sessionId, content, log.id)
		return log
	}

	/** `feed`, but for a finalizer built with its own options in a test. */
	async function feedInstance(
		instance: InteractiveTurnFinalizer,
		sessionId: string,
		content: string,
	) {
		const [log] = await db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'stdout', content })
			.returning()
		if (!log) throw new Error('failed to insert log')
		await instance.onStdout(sessionId, content, log.id)
		return log
	}

	async function messagesFor(conversation: string) {
		return db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversation))
			.orderBy(messages.id)
	}

	beforeEach(async () => {
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent' })
		if (!human || !agent) throw new Error('failed to seed actors')
		humanId = human.id
		agentId = agent.id

		const workspace = await insertWorkspace(db, humanId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id

		finalizer = new InteractiveTurnFinalizer(db)
	})

	it('posts the end-of-turn output as a message from the agent', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is the answer.')
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		expect((rows[0]?.metadata as { source?: string })?.source).toBe('final_output')
	})

	it('bumps lastMessageAt and logs a message_posted event', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const [conversation] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, conversationId))
		expect(conversation?.lastMessageAt).not.toBeNull()

		const eventRows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, conversationId), eq(events.action, 'message_posted')))
		expect(eventRows).toHaveLength(1)
	})

	it('posts only once when the same result line is replayed', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')
		const line = resultLine()

		await feed(session.id, `${line}\n`)
		await feed(session.id, `${line}\n`)
		// Clearing the in-process cache proves the DB unique index is the guard.
		// The local Docker path replays a session's ENTIRE log on first connect
		// (`tail: 'all'`), and after an apps/dev restart the cache is empty — so
		// if the index weren't doing the work, every past turn would re-post.
		finalizer.clearSeenCache()
		await feed(session.id, `${line}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(1)
	})

	it('treats two distinct turns as distinct messages', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: 'first', duration_ms: 1 })}\n`)
		await feed(session.id, `${resultLine({ result: 'second', duration_ms: 2 })}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows.map((r) => r.content)).toEqual(['first', 'second'])
	})

	it('reassembles a result envelope split across two chunks', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')
		const line = resultLine()
		const cut = Math.floor(line.length / 2)

		// Docker delivers chunks, not lines — a chunk can end mid-JSON.
		await feed(session.id, line.slice(0, cut))
		await feed(session.id, `${line.slice(cut)}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is the answer.')
	})

	it('tells the human when a turn produced nothing and nothing can ask the model again', async () => {
		// This used to post nothing: a blank result with no reply anywhere in the
		// turn is the model saying nothing at all, which the human reads as being
		// ignored. With no way to ask again, say so.
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: '' })}\n`)
		await feed(session.id, `${resultLine({ result: '   ', duration_ms: 9 })}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.content).toContain("I couldn't complete that turn")
	})

	it('recovers the reply from the turn when the result envelope is blank', async () => {
		// The live failure (session 9b050dec, 2026-08-25): the agent wrote its
		// reply, then emitted a trailing `thinking` block, and the CLI closed the
		// turn with `result: ' '`. The reply was dropped and the human saw
		// silence until the session timed out two hours later.
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${userTurnLine(1)}
`,
		)
		await feed(
			session.id,
			`${assistantLine('Let me check the integrations')}
`,
		)
		await feed(
			session.id,
			`${assistantLine("Tell me your office city and I'll build it.")}
`,
		)
		await feed(
			session.id,
			`${thinkingLine('The tool result looks odd. I should end my turn.')}
`,
		)
		await feed(
			session.id,
			`${resultLine({ result: ' ' })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe("Tell me your office city and I'll build it.")
		expect(
			(rows[0]?.metadata as { final_output?: { recovered?: boolean } })?.final_output?.recovered,
		).toBe(true)
	})

	it('does not reach into the previous turn when a turn is genuinely silent', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${userTurnLine(1)}
`,
		)
		await feed(
			session.id,
			`${assistantLine('First turn reply.')}
`,
		)
		await feed(
			session.id,
			`${resultLine({ result: 'First turn reply.' })}
`,
		)
		// Second turn: the agent replied via the MCP tool and closed silently.
		await feed(
			session.id,
			`${userTurnLine(2)}
`,
		)
		await feed(session.id, `${toolUseLine('mcp__maskin__post_conversation_message')}\n`)
		await feed(session.id, `${toolResultLine()}\n`)
		await feed(
			session.id,
			`${resultLine({ result: '', duration_ms: 7 })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('First turn reply.')
	})

	it('does not recover a sub-agent result as the reply', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${userTurnLine(1)}
`,
		)
		await feed(
			session.id,
			`${assistantLine('internal sub-agent finding', { parent_tool_use_id: 'call_parent' })}
`,
		)
		await feed(
			session.id,
			`${resultLine({ result: '' })}
`,
		)

		// The sub-agent's text is not the turn's reply. The turn itself said
		// nothing, so the human is told that instead of being shown the finding.
		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toContain("I couldn't complete that turn")
		expect(rows[0]?.content).not.toContain('internal sub-agent finding')
	})

	// The tests above feed one envelope per log row, which is what the
	// agent-server ingest path does. Local Docker does not: session-manager
	// writes `chunk.data` verbatim, so one row can carry several envelopes.
	// These three pin the recovery scan against that shape.

	it('recovers the reply when the whole turn arrives as one Docker chunk', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		// Reply and blank result in the SAME row — the single most likely place
		// the lost text sits, and the one an exclusive `id < logId` scan skipped.
		await feed(
			session.id,
			`${userTurnLine(1)}
${assistantLine("Tell me your office city and I'll build it.")}
${thinkingLine('The tool result looks odd. I should end my turn.')}
${resultLine({ result: ' ' })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe("Tell me your office city and I'll build it.")
		expect(
			(rows[0]?.metadata as { final_output?: { recovered?: boolean } })?.final_output?.recovered,
		).toBe(true)
	})

	it('does not re-post an earlier reply when the turn boundary is inside a packed chunk', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${assistantLine('First turn reply.')}
`,
		)
		// Turn 1 closes and turn 2 opens in one chunk. A scan that cannot see
		// inside the row walks straight past both boundaries and re-posts the
		// first turn's reply — a message the human has already read.
		await feed(
			session.id,
			`${resultLine({ result: 'First turn reply.' })}
${userTurnLine(2)}
${toolUseLine('mcp__maskin__post_conversation_message')}
`,
		)
		await feed(
			session.id,
			`${resultLine({ result: ' ', duration_ms: 7 })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('First turn reply.')
	})

	it('recovers the reply from a turn that dispatched a sub-agent before closing blank', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${userTurnLine(1)}
`,
		)
		await feed(
			session.id,
			`${assistantLine('Here is what I found.')}
`,
		)
		// A Task tool's own result closes the sub-agent's run, not this turn.
		await feed(
			session.id,
			`${resultLine({ result: 'sub-agent answer', parent_tool_use_id: 'call_parent' })}
`,
		)
		await feed(
			session.id,
			`${resultLine({ result: '' })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is what I found.')
	})

	it('posts an error result and tags it', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(
			session.id,
			`${resultLine({ is_error: true, subtype: 'error_max_turns', result: 'Ran out of turns.' })}\n`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		const finalOutput = (rows[0]?.metadata as { final_output?: Record<string, unknown> })
			?.final_output
		expect(finalOutput?.is_error).toBe(true)
		expect(finalOutput?.subtype).toBe('error_max_turns')
	})

	it('truncates output longer than the message limit', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine({ result: 'x'.repeat(9000) })}\n`)

		const rows = await messagesFor(conversationId)
		expect(rows[0]?.content).toHaveLength(8000)
		expect(
			(rows[0]?.metadata as { final_output?: { truncated?: boolean } })?.final_output?.truncated,
		).toBe(true)
	})

	it('ignores sub-agent result envelopes', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		// A Task tool's own result — intermediate output, not the agent's reply.
		await feed(session.id, `${resultLine({ parent_tool_use_id: 'toolu_1' })}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('ignores non-interactive sessions and interactive ones with no conversation', async () => {
		const oneShot = await seedSession({ interactive: false })
		const detached = await seedSession({ conversationId: null })
		if (!oneShot || !detached) throw new Error('no session')

		await feed(oneShot.id, `${resultLine()}\n`)
		await feed(detached.id, `${resultLine({ duration_ms: 7 })}\n`)

		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('recovers once a conversation is attached, rather than caching the miss forever', async () => {
		const session = await seedSession({ conversationId: null })
		if (!session) throw new Error('no session')

		// First turn lands before the conversation is wired up. The old cache
		// stored this unresolved gate and dropped every later turn of the session.
		await feed(
			session.id,
			`${resultLine({ duration_ms: 1 })}
`,
		)
		expect(await messagesFor(conversationId)).toHaveLength(0)

		await db.update(sessions).set({ conversationId }).where(eq(sessions.id, session.id))

		await feed(
			session.id,
			`${resultLine({ duration_ms: 2 })}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Here is the answer.')
	})

	it('posts a later result line even when an earlier one in the same chunk fails', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		// The buffer advances past every line in the chunk, so a per-chunk catch
		// would lose the second reply permanently.
		const failing = resultLine({ result: 'first', duration_ms: 1 })
		const surviving = resultLine({ result: 'second', duration_ms: 2 })

		type TurnResolver = {
			resolveTurnMessageId(sessionId: string, logId: number): Promise<number | null>
		}
		const seam = finalizer as unknown as TurnResolver
		const original = seam.resolveTurnMessageId.bind(seam)
		let calls = 0
		seam.resolveTurnMessageId = async (sessionId: string, logId: number) => {
			calls += 1
			if (calls === 1) throw new Error('transient db fault')
			return original(sessionId, logId)
		}

		await feed(
			session.id,
			`${failing}
${surviving}
`,
		)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('second')
	})

	it('attributes the output to the chat message whose turn produced it', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		const [trigger] = await db
			.insert(messages)
			.values({ conversationId, actorId: humanId, content: 'what is the status?' })
			.returning()
		if (!trigger) throw new Error('no trigger message')

		// writeInput persists the user turn tagged with the message id.
		await feed(
			session.id,
			`${JSON.stringify({
				type: 'user',
				message: { role: 'user', content: 'what is the status?' },
				maskin_message_id: trigger.id,
			})}\n`,
		)
		await feed(session.id, `${resultLine()}\n`)

		const [posted] = await db
			.select()
			.from(messages)
			.where(eq(messages.actorId, agentId))
			.orderBy(desc(messages.id))
			.limit(1)
		expect(
			(posted?.metadata as { final_output?: { message_id?: number } })?.final_output?.message_id,
		).toBe(trigger.id)
	})

	// The transport that fills session_logs must preserve the trailing newline
	// on every row. onStdout re-splits what it is given with splitLines(), which
	// pops the final segment as an incomplete "remainder" — so a row that does
	// not end in \n yields ZERO lines and its result envelope is never parsed.
	// The reply then renders optimistically from the stream and degrades to
	// "Not saved yet" in the UI, with nothing ever persisted.
	//
	// This is a real regression: output-stream.js initially stripped the newline
	// when it replaced the curl upload, and every agent reply silently stopped
	// being saved while looking, in the logs, like it had worked.
	it('does not post a result line that arrives without its trailing newline', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, resultLine()) // no trailing \n

		const rows = await messagesFor(conversationId)
		expect(rows.filter((r) => r.actorId === agentId)).toHaveLength(0)

		// Terminating the same line releases it, proving the newline is the
		// whole difference rather than something else about the payload.
		await feed(session.id, '\n')
		const after = await messagesFor(conversationId)
		expect(after.filter((r) => r.actorId === agentId)).toHaveLength(1)
	})

	it('records a null turn attribution when no tagged turn precedes the result', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		await feed(session.id, `${resultLine()}\n`)

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { final_output?: { message_id?: number | null } })?.final_output
				?.message_id,
		).toBeNull()
	})

	it('does not create any session — an auto-post cannot wake another agent', async () => {
		const session = await seedSession()
		if (!session) throw new Error('no session')

		const before = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		await feed(session.id, `${resultLine()}\n`)
		const after = await messagesFor(conversationId)

		// The finalizer never calls evaluateAndRespond, so exactly one message
		// appears and no responder chain can start from it.
		expect(after).toHaveLength(before.length + 1)
	})

	describe('turn-finished signal (drives the Live Activity)', () => {
		function withSignal() {
			const finished: Array<{ sessionId: string; outcome: string }> = []
			const calls: unknown[] = []
			const instance = new InteractiveTurnFinalizer(db, {
				onTurnFinished: (sessionId, outcome) => finished.push({ sessionId, outcome }),
				retryTurn: async (_s, payload) => {
					calls.push(payload)
				},
				delay: async () => {},
			})
			return { instance, finished, calls }
		}

		it('signals done once when the reply is posted, and not again for a redelivered line', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, finished } = withSignal()
			finalizer = instance
			await feed(session.id, `${userTurnLine(31)}\n`)
			await feed(session.id, `${resultLine()}\n`)
			await feed(session.id, `${resultLine()}\n`)
			expect(finished).toEqual([{ sessionId: session.id, outcome: 'done' }])
		})

		it('signals done for a turn that ends with nothing to post', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, finished } = withSignal()
			finalizer = instance
			await feed(session.id, `${userTurnLine(32)}\n`)
			await feed(session.id, `${resultLine({ result: '' })}\n`)
			expect(finished).toEqual([{ sessionId: session.id, outcome: 'done' }])
		})

		it('signals failed when the human is told the turn failed', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, finished } = withSignal()
			finalizer = instance
			await feed(session.id, `${userTurnLine(33)}\n`)
			await feed(
				session.id,
				`${resultLine({ is_error: true, result: 'Credit balance is too low' })}\n`,
			)
			expect(finished).toEqual([{ sessionId: session.id, outcome: 'failed' }])
		})

		it('does not signal while a transient failure is being replayed', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, finished, calls } = withSignal()
			finalizer = instance
			await feed(session.id, `${userTurnLine(34)}\n`)
			await feed(
				session.id,
				`${resultLine({ is_error: true, result: 'API Error: {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_x"}' })}\n`,
			)
			await finalizer.settlePendingRetries()
			expect(calls).toHaveLength(1)
			expect(finished).toEqual([])
		})

		it('survives a throwing listener', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			finalizer = new InteractiveTurnFinalizer(db, {
				onTurnFinished: () => {
					throw new Error('boom')
				},
			})
			await feed(session.id, `${userTurnLine(35)}\n`)
			await feed(session.id, `${resultLine()}\n`)
			expect(await messagesFor(conversationId)).toHaveLength(1)
		})
	})

	describe('a turn that failed against the model API', () => {
		/** The envelope the CLI writes when a request 500s mid-turn. */
		function apiErrorLine(requestId: string) {
			return resultLine({
				is_error: true,
				result: `API Error: {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"${requestId}"}`,
			})
		}

		/** A finalizer wired to a recording replay, with the backoff stubbed out. */
		function withRetry(options: { replyTimeoutMs?: number } = {}) {
			const calls: Array<{ sessionId: string; payload: unknown }> = []
			const instance = new InteractiveTurnFinalizer(db, {
				retryTurn: async (sessionId, payload) => {
					calls.push({ sessionId, payload })
				},
				delay: async () => {},
				...options,
			})
			return { instance, calls }
		}

		/** Polls until `check` passes, so a watchdog's real timer can be awaited. */
		async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000) {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (await check()) return
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
			throw new Error('condition never became true')
		}

		it('replays the turn instead of posting the raw error', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(11)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()

			// The human sees nothing: the turn is being run again, not reported.
			expect(await messagesFor(conversationId)).toHaveLength(0)
			expect(calls).toHaveLength(1)
			expect(calls[0]?.sessionId).toBe(session.id)
			// Replayed verbatim — same content, and without the Maskin-only tag,
			// which the CLI must never see on stdin.
			expect(calls[0]?.payload).toEqual({
				type: 'user',
				message: { role: 'user', content: 'hello' },
			})
		})

		it('gives up after the replay budget and tells the human in words', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(12)}
`,
			)
			// Distinct request ids: each failure is its own envelope, so the
			// dedupe guard cannot be what stops the third attempt.
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_2')}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_3')}
`,
			)
			await finalizer.settlePendingRetries()

			expect(calls).toHaveLength(2)
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).not.toContain('API Error')
			const finalOutput = (rows[0]?.metadata as { final_output?: Record<string, unknown> })
				?.final_output
			expect(finalOutput?.error_kind).toBe('transient')
			expect(finalOutput?.retries).toBe(2)
		})

		it('does not replay a failure no retry could fix', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(13)}
`,
			)
			await feed(
				session.id,
				`${resultLine({ is_error: true, result: 'Credit balance is too low' })}
`,
			)
			await finalizer.settlePendingRetries()

			expect(calls).toHaveLength(0)
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			// The detail still reaches the human — it is the actionable part.
			expect(rows[0]?.content).toContain('Credit balance is too low')
			expect(
				(rows[0]?.metadata as { final_output?: { error_kind?: string } })?.final_output?.error_kind,
			).toBe('permanent')
		})

		it('moves the workspace to the next subscription when a turn hits a limit', async () => {
			// An interactive session never exits, so the session-exit failover
			// never sees a spent subscription. Without this the workspace stayed
			// pointed at the dead one and the next session landed on it too.
			const moved: Array<{ sessionId: string; reason: string }> = []
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async (sessionId, reason) => {
					moved.push({ sessionId, reason })
					return 'backup'
				},
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: "You've hit your weekly limit" })}\n`,
			)
			await instance.settlePendingRetries()

			expect(moved).toEqual([{ sessionId: session.id, reason: 'weekly_limit' }])
			const rows = await messagesFor(conversationId)
			// Copy names the stop explicitly — the current session is going away, so
			// the human's next message here spawns a fresh session on the new slot.
			expect(rows[0]?.content).toContain('switched this workspace to the next connected one')
			expect(rows[0]?.content).toContain('stopped this session')
			expect(rows[0]?.content).toContain("Send your next message here and I'll pick up")
			expect(
				(rows[0]?.metadata as { final_output?: { subscription_moved_to?: string } })?.final_output
					?.subscription_moved_to,
			).toBe('backup')
		})

		it('stops the session after the pointer moves so the next message spawns a fresh one', async () => {
			// The pointer-move alone is not enough on the live path: the running
			// container launched with the now-spent credential and can't be
			// resumed in place. Stopping it means the human's next message spawns
			// a fresh session that reads the new active_slot.
			//
			// onStopSession is wired to sessionManager.stopSession in prod. The
			// finalizer only calls it after `onSubscriptionLimit` reports a
			// move — a null-move (no chain left) must NOT stop.
			const stopped: Array<{ sessionId: string; reason: string }> = []
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async () => 'backup',
				onStopSession: async (sessionId, reason) => {
					stopped.push({ sessionId, reason })
				},
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: "You've hit your weekly limit" })}\n`,
			)
			await instance.settlePendingRetries()

			expect(stopped).toEqual([{ sessionId: session.id, reason: 'subscription_moved' }])
		})

		it('does not stop the session when nothing moved (chain exhausted)', async () => {
			// If the whole chain is spent there's nowhere to fall over to and the
			// current session should keep running so the human can decide (e.g.
			// import another subscription). onSubscriptionLimit returning null is
			// the signal — onStopSession must not fire.
			const stopped: string[] = []
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async () => null,
				onStopSession: async (sessionId) => {
					stopped.push(sessionId)
				},
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: "You've hit your weekly limit" })}\n`,
			)
			await instance.settlePendingRetries()

			expect(stopped).toEqual([])
		})

		it('does not treat an onStopSession failure as fatal — the human still sees the moved-subscription notice', async () => {
			// The stop is best-effort. A stopSession error (network blip to the
			// remote agent-server, or a container that's already gone) must not
			// prevent the human from seeing why their turn ended.
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async () => 'backup',
				onStopSession: async () => {
					throw new Error('agent-server 502')
				},
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: "You've hit your weekly limit" })}\n`,
			)
			await instance.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows[0]?.content).toContain('switched this workspace to the next connected one')
		})

		it('reports the plain error when there is no subscription to move to', async () => {
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async () => null,
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: "You've hit your weekly limit" })}\n`,
			)
			await instance.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows[0]?.content).toContain("You've hit your weekly limit")
			expect(rows[0]?.content).not.toContain('switched this workspace')
		})

		it('does not treat a non-limit permanent failure as a subscription limit', async () => {
			const moved: string[] = []
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				onSubscriptionLimit: async (sessionId) => {
					moved.push(sessionId)
					return 'backup'
				},
			})
			const session = await seedSession()
			if (!session) throw new Error('no session')

			await feedInstance(
				instance,
				session.id,
				`${resultLine({ is_error: true, result: 'invalid_request_error: bad tool schema' })}\n`,
			)
			await instance.settlePendingRetries()

			expect(moved).toEqual([])
		})

		it('reports a transient failure it cannot replay', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// No retryTurn wired — e.g. a caller with no way to write stdin.
			finalizer = new InteractiveTurnFinalizer(db, { delay: async () => {} })

			await feed(
				session.id,
				`${userTurnLine(14)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('unavailable')
		})

		it('tells the human when the replay cannot reach the CLI', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			finalizer = new InteractiveTurnFinalizer(db, {
				retryTurn: async () => {
					throw new Error('session is gone')
				},
				delay: async () => {},
			})

			await feed(
				session.id,
				`${userTurnLine(15)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('undeliverable')
		})

		it('does not spend a second attempt on a replayed log line', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(16)}
`,
			)
			const line = apiErrorLine('req_1')
			await feed(
				session.id,
				`${line}
`,
			)
			// The agent-server replays stdout on reconnect; the same envelope
			// arriving twice is one failure, not two.
			await feed(
				session.id,
				`${line}
`,
			)
			await finalizer.settlePendingRetries()

			expect(calls).toHaveLength(1)
		})

		it('gives the next turn a fresh budget once a replay has worked', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(17)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()
			expect(calls).toHaveLength(1)

			// The replay produced a real answer, so the fault it was counting is
			// over. The budget is keyed on the message text, and identical text
			// recurs constantly in chat — a counter left behind here would spend
			// the next such turn's attempts before it had failed even once.
			await feed(
				session.id,
				`${resultLine()}
`,
			)

			await feed(
				session.id,
				`${apiErrorLine('req_2')}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_3')}
`,
			)
			await finalizer.settlePendingRetries()

			expect(calls).toHaveLength(3)
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('Here is the answer.')
		})

		it('tells the human when a replayed turn never comes back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// writeInput resolves when the bytes are queued, not when the turn
			// runs — a CLI wedged on stdin swallows the replay in total silence.
			const { instance, calls } = withRetry({ replyTimeoutMs: 10 })
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(18)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()
			expect(calls).toHaveLength(1)

			await eventually(async () => (await messagesFor(conversationId)).length === 1)
			const rows = await messagesFor(conversationId)
			expect(rows[0]?.content).not.toContain('API Error')
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('unanswered')
		})

		it('stands the watchdog down when the replayed turn answers', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance } = withRetry({ replyTimeoutMs: 40 })
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(19)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()
			await feed(
				session.id,
				`${resultLine()}
`,
			)

			// Past the watchdog's deadline: the answer must have cancelled it,
			// not merely raced it.
			await new Promise((resolve) => setTimeout(resolve, 120))
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('Here is the answer.')
		})

		it('stands the watchdog down even when the answer beats the write', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// In production writeInput only resolves after a round trip to the
			// agent-server and a log insert, so a fast turn can close inside that
			// window. The watchdog must already be armed — and disarmable — before
			// the write resolves, or it fires against a turn the human has read.
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				replyTimeoutMs: 40,
				retryTurn: async (sessionId) => {
					await feed(
						sessionId,
						`${resultLine()}
`,
					)
				},
			})
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(20)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()

			await new Promise((resolve) => setTimeout(resolve, 120))
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('Here is the answer.')
		})

		it('ignores a re-delivered older result when deciding the turn came back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance } = withRetry({ replyTimeoutMs: 40 })
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(21)}
`,
			)
			const staleResult = await feed(
				session.id,
				`${resultLine({ result: 'An older answer.' })}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()

			// The agent-server replays stdout on reconnect. Re-delivering that
			// older result proves nothing about the replayed turn, so it must not
			// stand the watchdog down — the failure envelope is already deduped,
			// so nothing else would ever tell the human.
			await finalizer.onStdout(
				session.id,
				`${resultLine({ result: 'An older answer.' })}
`,
				staleResult.id,
			)

			await eventually(async () =>
				(await messagesFor(conversationId)).some(
					(row) =>
						(row.metadata as { final_output?: { retry?: string } })?.final_output?.retry ===
						'unanswered',
				),
			)
		})

		it('gives up on a replay whose write never returns, rather than hanging the exit', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// writeInput's fetch to an agent-server carries no AbortSignal, so a
			// hung box makes this promise never settle. The shutdown that awaits
			// settlePendingRetries must still come back.
			const instance = new InteractiveTurnFinalizer(db, {
				delay: async () => {},
				retryTurn: () => new Promise<void>(() => {}),
			})
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(22)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)

			const startedAt = Date.now()
			await finalizer.settlePendingRetries(50)
			expect(Date.now() - startedAt).toBeLessThan(2_000)
		})

		it('reports a turn still in its backoff when the process is shutting down', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// The failure envelope is already marked seen, so if shutdown drops a
			// turn that is still waiting out its backoff, nothing will ever post
			// for it. The second attempt's backoff (8s) is the same length as the
			// settle budget, so this is not a narrow race.
			const calls: string[] = []
			finalizer = new InteractiveTurnFinalizer(db, {
				retryTurn: async (sessionId) => {
					calls.push(sessionId)
				},
				// Never resolves: the replay is still in backoff when we exit.
				delay: () => new Promise<void>(() => {}),
				replyTimeoutMs: 60_000,
			})

			await feed(
				session.id,
				`${userTurnLine(24)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)

			// Shutdown: gives up on the in-flight replay, then must still account
			// for the turn it is abandoning.
			await finalizer.settleForShutdown(800)

			expect(calls).toHaveLength(0)
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).not.toContain('API Error')
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('unanswered')
		})

		it('reports a replayed turn still in flight when the session goes away', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// The watchdog is unref'd and in-process: dropping it on forgetSession
			// would leave the human in an empty thread with no message at all.
			const { instance } = withRetry({ replyTimeoutMs: 60_000 })
			finalizer = instance

			await feed(
				session.id,
				`${userTurnLine(23)}
`,
			)
			await feed(
				session.id,
				`${apiErrorLine('req_1')}
`,
			)
			await finalizer.settlePendingRetries()
			expect(await messagesFor(conversationId)).toHaveLength(0)

			finalizer.forgetSession(session.id)

			await eventually(async () => (await messagesFor(conversationId)).length === 1)
			const rows = await messagesFor(conversationId)
			expect(rows[0]?.content).not.toContain('API Error')
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('unanswered')
		})
	})

	describe('turns that write tool calls out as text', () => {
		/**
		 * A closing turn whose "reply" is the model narrating tool calls it never
		 * made. `is_error` is false — this is the shape that made it into a
		 * customer's chat, and nothing above this check catches it.
		 */
		function pseudoToolCallLine(seed = 'a') {
			return resultLine({
				result: [
					`Past the timeout window — checking status. (${seed})`,
					'<skill_called>mcp__maskin__get_session</skill_called>',
					'<skill_called>id=ab464315-40a6-4ab3-8bfb-ac175817945e</skill_called>',
					'<skill_called>result-not-ready</skill_called>',
					'<skill_called>retry</skill_called>',
					'<skill_called>$PATH = /home/agent/.claude/projects/-agent-workspace/088a9cc6</skill_called>',
				].join('\n\n'),
			})
		}

		function withRetry(options: { replyTimeoutMs?: number; retryTurn?: RetryTurnFn } = {}) {
			const { retryTurn, ...rest } = options
			const calls: Array<{ sessionId: string; payload: unknown }> = []
			const instance = new InteractiveTurnFinalizer(db, {
				retryTurn: async (sessionId, payload) => {
					calls.push({ sessionId, payload })
					await retryTurn?.(sessionId, payload)
				},
				delay: async () => {},
				...rest,
			})
			return { instance, calls }
		}

		/** Polls until `check` passes, so a watchdog's real timer can be awaited. */
		async function eventuallyTrue(check: () => Promise<boolean>, timeoutMs = 2_000) {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (await check()) return
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
			throw new Error('condition never became true')
		}

		it('asks the model to run the tools instead of posting the markup', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine()}\n`)
			await finalizer.settlePendingRetries()

			// Nothing reaches the human: the turn is being redone, not reported,
			// and neither the markup nor the container path it carried is posted.
			expect(await messagesFor(conversationId)).toHaveLength(0)
			expect(calls).toHaveLength(1)
			expect(calls[0]?.sessionId).toBe(session.id)

			const payload = calls[0]?.payload as { message?: { role?: string; content?: string } }
			expect(payload.message?.role).toBe('user')
			// The correction has to name the mistake and its consequence, or the
			// model has no reason to do anything different on the next attempt.
			expect(payload.message?.content).toContain('writing tool calls out as text')
			expect(payload.message?.content).toContain('Nothing ran')
		})

		it('posts the reply the corrected turn produces', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance } = withRetry()
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine()}\n`)
			await finalizer.settlePendingRetries()
			await feed(session.id, `${resultLine({ result: 'The session is still running.' })}\n`)

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('The session is still running.')
		})

		it('tells the human in plain words when the correction does not take', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine('a')}\n`)
			await finalizer.settlePendingRetries()
			// Same failure again — a different envelope, so dedupe cannot hide it.
			await feed(session.id, `${pseudoToolCallLine('b')}\n`)
			await finalizer.settlePendingRetries()

			// Corrected once, not twice: the budget is per session, so the new
			// turn's different content must not buy it a fresh attempt.
			expect(calls).toHaveLength(1)

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain('instead of running them')
			expect(rows[0]?.content).not.toContain('skill_called')
			expect(rows[0]?.content).not.toContain('/home/agent')
		})

		it('gives a session a fresh budget once it replies properly', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, calls } = withRetry()
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine('a')}\n`)
			await finalizer.settlePendingRetries()
			await feed(session.id, `${resultLine({ result: 'Recovered — here is the answer.' })}\n`)
			await feed(session.id, `${pseudoToolCallLine('b')}\n`)
			await finalizer.settlePendingRetries()

			// A good turn in between proves the model is emitting real calls
			// again, so a later lapse is a new episode and gets its own nudge.
			expect(calls).toHaveLength(2)
		})

		it('tells the human in its own words when the corrected turn never comes back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			// writeInput resolves when the bytes are queued, not when the turn
			// runs — a CLI wedged on stdin swallows the correction in silence.
			const { instance, calls } = withRetry({ replyTimeoutMs: 10 })
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine()}\n`)
			await finalizer.settlePendingRetries()
			expect(calls).toHaveLength(1)

			await eventuallyTrue(async () => (await messagesFor(conversationId)).length === 1)
			const rows = await messagesFor(conversationId)
			// The watchdog must describe THIS failure. Its notice text was once
			// hardcoded to the model-API wording, which names an error that never
			// happened and sends the human looking in the wrong place.
			expect(rows[0]?.content).toContain('instead of running them')
			expect(rows[0]?.content).not.toContain('Claude API')
			expect(rows[0]?.content).not.toContain('skill_called')

			const meta = (rows[0]?.metadata as { final_output?: Record<string, unknown> })?.final_output
			expect(meta?.retry).toBe('unanswered')
			// And it must be distinguishable from a model-API failure in the audit
			// trail, not just in the prose the human reads.
			expect(meta?.pseudo_tool_calls).toMatchObject({ nudges: 1 })
		})

		it('tells the human when the correction cannot be delivered', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance } = withRetry({
				retryTurn: async () => {
					throw new Error('session gone')
				},
			})
			finalizer = instance

			await feed(session.id, `${pseudoToolCallLine()}\n`)
			await finalizer.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain('instead of running them')
			expect(rows[0]?.content).not.toContain('Claude API')
			expect(
				(rows[0]?.metadata as { final_output?: { retry?: string } })?.final_output?.retry,
			).toBe('undeliverable')
		})

		it('says so without claiming a retry when nothing can write stdin', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			finalizer = new InteractiveTurnFinalizer(db, { delay: async () => {} })

			await feed(session.id, `${pseudoToolCallLine()}\n`)
			await finalizer.settlePendingRetries()

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain('instead of running them')
			expect(rows[0]?.content).not.toContain('tried again')
			expect(rows[0]?.content).not.toContain('skill_called')
		})
	})

	describe('turns whose last model call came back empty', () => {
		const PRIMARY = 'deepseek/deepseek-v4-flash-0731'
		const FALLBACK = 'deepseek/deepseek-v4-flash'

		function withEmptyTurnHandling(
			options: { fallbackModel?: string | null; replyTimeoutMs?: number } = {},
		) {
			const retries: Array<{ sessionId: string; content: string }> = []
			const models: string[] = []
			const instance = new InteractiveTurnFinalizer(db, {
				retryTurn: async (sessionId, payload) => {
					retries.push({ sessionId, content: payload.message.content })
				},
				setModel: async (_sessionId, model) => {
					models.push(model)
				},
				delay: async () => {},
				...options,
			})
			return { instance, retries, models }
		}

		/**
		 * A turn the way the live failure laid it out: the model narrates, calls a
		 * tool, gets the result back, and its next call returns nothing. The CLI
		 * then closes with a blank success `result`.
		 */
		async function feedEmptyTurn(sessionId: string, messageId: number, seed = 'a') {
			await feed(sessionId, `${userTurnLine(messageId)}\n`)
			await feed(sessionId, `${assistantLine('Almost there...')}\n`)
			await feed(sessionId, `${toolUseLine('Read')}\n`)
			await feed(sessionId, `${toolResultLine()}\n`)
			return feed(sessionId, `${resultLine({ result: '', duration_ms: seed.charCodeAt(0) })}\n`)
		}

		/** The blank result the CLI emits after our correction is also answered with nothing. */
		async function feedEmptyRetry(sessionId: string, seed: string) {
			return feed(sessionId, `${resultLine({ result: '', duration_ms: seed.charCodeAt(0) })}\n`)
		}

		async function waitFor(instance: InteractiveTurnFinalizer) {
			await instance.settlePendingRetries()
		}

		it('recognises the turn the real CLI wrote when the model went empty after a tool result', async () => {
			// Captured from claude-code 2.1.285 against a model that answers a tool
			// result with nothing: narration and tool call on separate lines, the
			// tool_result, the CLI's own synthetic "no visible output" nudge, and a
			// success result with an empty string. No assistant row for the empty
			// call, which is why this was invisible in session_logs.
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries } = withEmptyTurnHandling()
			finalizer = instance
			const captured = readFileSync(
				join(__dirname, '..', 'fixtures', 'claude-empty-completion-turn.jsonl'),
				'utf8',
			)
				.split('\n')
				.filter(Boolean)
			expect(captured.at(-1)).toContain('"type":"result"')

			await feed(session.id, `${userTurnLine(1)}\n`)
			for (const line of captured) await feed(session.id, `${line}\n`)
			await waitFor(instance)

			expect(await messagesFor(conversationId)).toHaveLength(0)
			expect(retries).toHaveLength(1)
		})

		it('asks the model again instead of staying silent, and does not post the narration', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries, models } = withEmptyTurnHandling()
			finalizer = instance

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)

			// "Almost there..." was said ahead of a tool call, so it is not the reply.
			expect(await messagesFor(conversationId)).toHaveLength(0)
			expect(retries).toHaveLength(1)
			expect(retries[0]?.sessionId).toBe(session.id)
			// A correction, not a replay of the human's message: the tools already ran.
			expect(retries[0]?.content).toContain('Continue from where you left off')
			expect(retries[0]?.content).not.toBe('hello')
			expect(models).toEqual([])
		})

		it('posts the reply once a retry produces one, after two empty results', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries, models } = withEmptyTurnHandling({ fallbackModel: FALLBACK })
			finalizer = instance
			await feed(session.id, `${initLine(PRIMARY)}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			expect(retries).toHaveLength(2)

			await feed(session.id, `${resultLine({ result: 'Here is what I found.' })}\n`)

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('Here is what I found.')
			// Two same-model retries were enough, so the fallback never came into it.
			expect(models).toEqual([])
		})

		it('switches to the fallback model after the same-model retries, then puts the primary back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries, models } = withEmptyTurnHandling({ fallbackModel: FALLBACK })
			finalizer = instance
			await feed(session.id, `${initLine(PRIMARY)}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			expect(models).toEqual([])

			// Third empty result: same-model retries are spent, so this one goes out on the fallback.
			await feedEmptyRetry(session.id, 'c')
			await waitFor(instance)
			expect(models).toEqual([FALLBACK])
			expect(retries).toHaveLength(3)

			// The fallback answers; the session goes straight back to its own model.
			await feed(session.id, `${resultLine({ result: 'Answered on the fallback.' })}\n`)
			expect(models).toEqual([FALLBACK, PRIMARY])

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toBe('Answered on the fallback.')
		})

		it('tells the human when the fallback is empty too, and records the turn as an empty completion', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries, models } = withEmptyTurnHandling({ fallbackModel: FALLBACK })
			finalizer = instance
			await feed(session.id, `${initLine(PRIMARY)}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'c')
			await waitFor(instance)
			// After a switch the CLI prints a fresh init line naming the NEW model.
			await feed(session.id, `${initLine(FALLBACK)}\n`)
			await feedEmptyRetry(session.id, 'd')
			await waitFor(instance)

			// Three attempts were made (two on the model, one on the fallback): no fourth.
			expect(retries).toHaveLength(3)
			expect(models).toEqual([FALLBACK, PRIMARY])

			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain("I couldn't complete that turn")
			expect(rows[0]?.content).toContain('Send your message again')
			const output = (
				rows[0]?.metadata as {
					final_output?: {
						is_error?: boolean
						error_kind?: string
						empty_completion?: { attempts: number; model: string | null; fallback_model?: string }
					}
				}
			)?.final_output
			// Never recorded as a clean turn, and not mistaken for an API failure.
			expect(output?.is_error).toBe(true)
			expect(output?.error_kind).toBeUndefined()
			expect(output?.empty_completion).toEqual({
				attempts: 3,
				model: PRIMARY,
				fallback_model: FALLBACK,
			})
		})

		it('gives up after the same-model retries when no fallback is configured', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries, models } = withEmptyTurnHandling({ fallbackModel: null })
			finalizer = instance
			await feed(session.id, `${initLine(PRIMARY)}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'c')
			await waitFor(instance)

			expect(retries).toHaveLength(2)
			expect(models).toEqual([])
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain("I couldn't complete that turn")
			const output = (
				rows[0]?.metadata as {
					final_output?: { empty_completion?: { attempts: number; fallback_model?: string } }
				}
			)?.final_output
			expect(output?.empty_completion?.attempts).toBe(2)
			expect(output?.empty_completion?.fallback_model).toBeUndefined()
		})

		it('does not send an OpenRouter model name to a session on another model family', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, models } = withEmptyTurnHandling({ fallbackModel: FALLBACK })
			finalizer = instance
			await feed(session.id, `${initLine('claude-sonnet-4-5')}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'c')
			await waitFor(instance)

			expect(models).toEqual([])
			expect(await messagesFor(conversationId)).toHaveLength(1)
		})

		it('does not treat a turn that replied through the chat tool as empty', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries } = withEmptyTurnHandling()
			finalizer = instance

			await feed(session.id, `${userTurnLine(1)}\n`)
			await feed(session.id, `${toolUseLine('Read')}\n`)
			await feed(session.id, `${toolResultLine()}\n`)
			await feed(session.id, `${toolUseLine('mcp__maskin__post_conversation_message')}\n`)
			await feed(session.id, `${toolResultLine()}\n`)
			await feed(session.id, `${resultLine({ result: '' })}\n`)
			await waitFor(instance)

			expect(retries).toHaveLength(0)
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('does treat it as empty when the agent kept working after the chat tool and then went blank', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries } = withEmptyTurnHandling()
			finalizer = instance

			await feed(session.id, `${userTurnLine(1)}\n`)
			await feed(session.id, `${toolUseLine('mcp__maskin__post_conversation_message')}\n`)
			await feed(session.id, `${toolResultLine()}\n`)
			await feed(session.id, `${toolUseLine('Read')}\n`)
			await feed(session.id, `${toolResultLine()}\n`)
			await feed(session.id, `${resultLine({ result: '' })}\n`)
			await waitFor(instance)

			expect(retries).toHaveLength(1)
		})

		it('does not retry a turn that is no longer the latest, as when history is replayed after a restart', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')

			// Turn 1 ended empty, the human moved on, turn 2 was answered.
			const insert = async (content: string) => {
				const [log] = await db
					.insert(sessionLogs)
					.values({ sessionId: session.id, stream: 'stdout', content })
					.returning()
				if (!log) throw new Error('failed to insert log')
				return log
			}
			await insert(`${userTurnLine(1)}\n`)
			const staleResult = await insert(`${resultLine({ result: '' })}\n`)
			await insert(`${userTurnLine(2)}\n`)
			await insert(`${resultLine({ result: 'Second turn reply.' })}\n`)

			// A fresh process re-reads the whole log and meets the old blank result again.
			const { instance, retries } = withEmptyTurnHandling()
			finalizer = instance
			await instance.onStdout(session.id, `${resultLine({ result: '' })}\n`, staleResult.id)
			await waitFor(instance)

			expect(retries).toHaveLength(0)
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('does not spend another attempt on a replayed log line', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries } = withEmptyTurnHandling()
			finalizer = instance

			const log = await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await instance.onStdout(
				session.id,
				`${resultLine({ result: '', duration_ms: 97 })}\n`,
				log.id,
			)
			await waitFor(instance)

			expect(retries).toHaveLength(1)
		})

		it('gives the next chat message a fresh budget', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance, retries } = withEmptyTurnHandling({ fallbackModel: null })
			finalizer = instance

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			expect(retries).toHaveLength(2)

			// The human sends another message and that one is empty too. Had the
			// first message's two attempts carried over, this would be a give-up.
			await feedEmptyTurn(session.id, 2, 'e')
			await waitFor(instance)
			expect(retries).toHaveLength(3)
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('tells the human when the correction cannot be delivered, and puts the model back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const models: string[] = []
			let writes = 0
			const instance = new InteractiveTurnFinalizer(db, {
				retryTurn: async () => {
					writes += 1
					// The fallback attempt is the third write; the first two go through.
					if (writes === 3) throw new Error('stdin closed')
				},
				setModel: async (_sessionId, model) => {
					models.push(model)
				},
				fallbackModel: FALLBACK,
				delay: async () => {},
			})
			finalizer = instance
			await feed(session.id, `${initLine(PRIMARY)}\n`)

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'b')
			await waitFor(instance)
			await feedEmptyRetry(session.id, 'c')
			await waitFor(instance)

			// The switch had landed before the write failed, so it is undone at once.
			expect(models).toEqual([FALLBACK, PRIMARY])
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain("couldn't ask it again")
		})

		it('tells the human when the nudge never comes back', async () => {
			const session = await seedSession()
			if (!session) throw new Error('no session')
			const { instance } = withEmptyTurnHandling({ replyTimeoutMs: 20 })
			finalizer = instance

			await feedEmptyTurn(session.id, 1)
			await waitFor(instance)

			const deadline = Date.now() + 2_000
			while (Date.now() < deadline && (await messagesFor(conversationId)).length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
			const rows = await messagesFor(conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.content).toContain('the run never came back')
		})
	})
})
