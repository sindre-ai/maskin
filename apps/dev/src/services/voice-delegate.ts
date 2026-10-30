import type { VoiceRealtimeTool } from '@maskin/mcp'
import { logger } from '../lib/logger'
import { capToolOutput } from './voice-tool-output'

/**
 * `ask_workspace`: the one tool the Realtime model has for everything outside its small core set
 * (packages/mcp/src/voice-tools.ts VOICE_CORE_TOOLS). A stronger text model runs the request with
 * the FULL toolkit and hands back a short answer to say aloud. The Realtime model gets a few tools
 * instead of ninety, so it starts faster and picks the right one more often.
 *
 * The delegate has no way around the write gate. Each tool call it makes goes through the same
 * review a direct call goes through (see the channel's delegatedCall): reads and ordinary writes
 * run, and the first call that needs the person's yes stops the loop and comes back as "not done
 * yet". The voice model asks the person, then repeats ask_workspace with the confirmation_id, and
 * the channel runs exactly the held call (the text model is not asked again).
 */

export const VOICE_ASK_WORKSPACE_TOOL = 'ask_workspace'

export const voiceAskWorkspaceTool = {
	type: 'function' as const,
	name: VOICE_ASK_WORKSPACE_TOOL,
	description:
		'Does anything you have no listed tool for, or are unsure which tool to use: looks things up across the workspace, makes changes, checks agents, sessions, files, triggers, integrations and more. Say a short "one sec" first. Describe what is wanted in one self-contained plain sentence or two, with every name, id and detail you know (it cannot hear the call). Returns a short result for you to say in your own words. If the answer says it is not done yet and needs a yes, ask the person, then call this again with the same request plus the confirmation_id from that answer.',
	parameters: {
		type: 'object',
		properties: {
			request: {
				type: 'string',
				description:
					'What is wanted, self-contained, in plain language. Include names, ids and details from the call.',
			},
			confirmation_id: {
				type: 'string',
				description:
					'Only when repeating a request you were told is not done yet: the id from that answer. Never set it on a first call.',
			},
		},
		required: ['request'],
	},
}

/** Largest number of model turns one request may take. */
export const VOICE_DELEGATE_MAX_STEPS = 8
/** Wall-clock budget for one request, model calls and tool calls together. */
export const VOICE_DELEGATE_BUDGET_MS = 25_000
/** What one tool result may add to the delegate's context. */
export const VOICE_DELEGATE_TOOL_RESULT_CHARS = 12_000
/** The answer handed back to the voice model; it has to be spoken. */
export const VOICE_DELEGATE_ANSWER_CHARS = 1_500
export const VOICE_DELEGATE_DEFAULT_MODEL = 'gpt-4.1'

export type DelegateMessage =
	| { role: 'system' | 'user'; content: string }
	| {
			role: 'assistant'
			content: string | null
			tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
	  }
	| { role: 'tool'; tool_call_id: string; content: string }

export interface DelegateModel {
	complete(input: {
		messages: DelegateMessage[]
		tools: VoiceRealtimeTool[]
		signal: AbortSignal
	}): Promise<{
		text: string | null
		toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
	}>
}

/** What one tool call of the delegate came to. */
export type DelegateCallOutcome =
	| { kind: 'result'; text: string; isError: boolean }
	/** The gate held it: `output` is the full "not done yet" answer for the voice model. */
	| { kind: 'held'; output: string; errorCode: string }

export type DelegateResult =
	| { kind: 'answer'; text: string }
	| { kind: 'held'; output: string; errorCode: string }
	| { kind: 'incomplete'; reason: 'steps' | 'time' | 'aborted' | 'error'; text: string }

export const VOICE_DELEGATE_SYSTEM_PROMPT = `You run one request for a voice assistant on a phone call, using the workspace tools.
- Do exactly what was asked, nothing more. Look things up with the tools; never guess a name, id or number.
- Some tools need the person's yes first. If a tool answers that it is not done yet, stop: do not call it again or try another way around it.
- Your answer is read out loud. Reply in plain spoken sentences, at most four short ones: no markdown, no lists, no ids, no links, no code. Say names, not ids.
- If you could not do it, say what stopped you in one sentence.`

const SECRET_PATTERNS = [
	/ank_[A-Za-z0-9_-]{8,}/g,
	/sk-[A-Za-z0-9_-]{16,}/g,
	/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	/xox[abpr]-[A-Za-z0-9-]{10,}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
]

/** Keys, bearer tokens and the like never go back to the voice model, even if a tool echoed one. */
export function redactSecrets(text: string): string {
	return SECRET_PATTERNS.reduce((out, re) => out.replace(re, '[redacted]'), text)
}

function describeCall(name: string): string {
	return name.replace(/_/g, ' ')
}

/**
 * The bounded loop: at most `maxSteps` model turns inside `budgetMs`, abortable by `signal`
 * (the call ending). `callTool` is the gated tool runner; it must never throw for a tool that
 * failed (return isError) but may reject for a broken connection, which ends the loop.
 */
export async function runVoiceDelegate(opts: {
	request: string
	tools: VoiceRealtimeTool[]
	model: DelegateModel
	callTool: (name: string, args: Record<string, unknown>) => Promise<DelegateCallOutcome>
	signal?: AbortSignal
	maxSteps?: number
	budgetMs?: number
	/** Extra lines for the system prompt, such as the caller's name and time zone. */
	context?: string
}): Promise<DelegateResult> {
	const maxSteps = opts.maxSteps ?? VOICE_DELEGATE_MAX_STEPS
	const budgetMs = opts.budgetMs ?? VOICE_DELEGATE_BUDGET_MS
	const toolNames = new Set(opts.tools.map((t) => t.name))
	const controller = new AbortController()
	const onOuterAbort = () => controller.abort('aborted')
	if (opts.signal?.aborted) return { kind: 'incomplete', reason: 'aborted', text: '' }
	opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
	const timer = setTimeout(() => controller.abort('time'), budgetMs)
	const stopReason = (): 'time' | 'aborted' =>
		controller.signal.reason === 'time' ? 'time' : 'aborted'

	// Rejects when the budget runs out or the call ends, so a tool that hangs cannot hold us.
	const aborted = new Promise<never>((_, reject) => {
		controller.signal.addEventListener('abort', () => reject(new Error(String(stopReason()))), {
			once: true,
		})
	})
	aborted.catch(() => {})

	const messages: DelegateMessage[] = [
		{
			role: 'system',
			content: opts.context
				? `${VOICE_DELEGATE_SYSTEM_PROMPT}\n\n${opts.context}`
				: VOICE_DELEGATE_SYSTEM_PROMPT,
		},
		{ role: 'user', content: opts.request },
	]
	const done: string[] = []
	const incomplete = (reason: 'steps' | 'time' | 'aborted' | 'error'): DelegateResult => ({
		kind: 'incomplete',
		reason,
		text: done.length > 0 ? `Done so far: ${done.join(', ')}.` : 'Nothing was done.',
	})

	try {
		for (let step = 0; step < maxSteps; step++) {
			const turn = await Promise.race([
				opts.model.complete({ messages, tools: opts.tools, signal: controller.signal }),
				aborted,
			])
			if (turn.toolCalls.length === 0) {
				const text = redactSecrets((turn.text ?? '').trim())
				return {
					kind: 'answer',
					text: capToolOutput(text || 'It is done.', VOICE_DELEGATE_ANSWER_CHARS),
				}
			}
			messages.push({ role: 'assistant', content: turn.text, tool_calls: turn.toolCalls })
			for (const call of turn.toolCalls) {
				if (!toolNames.has(call.name)) {
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						content: JSON.stringify({ error: `There is no tool called ${call.name}.` }),
					})
					continue
				}
				const outcome = await Promise.race([opts.callTool(call.name, call.arguments), aborted])
				if (outcome.kind === 'held') {
					return { kind: 'held', output: outcome.output, errorCode: outcome.errorCode }
				}
				if (!outcome.isError) done.push(describeCall(call.name))
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: capToolOutput(outcome.text, VOICE_DELEGATE_TOOL_RESULT_CHARS),
				})
			}
		}
		return incomplete('steps')
	} catch (err) {
		if (controller.signal.aborted) return incomplete(stopReason())
		logger.warn('Voice delegate failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return incomplete('error')
	} finally {
		clearTimeout(timer)
		opts.signal?.removeEventListener('abort', onOuterAbort)
		controller.abort('done')
	}
}

/** The delegate's model: OpenAI chat completions with the operator key the call already uses. */
export function openAiDelegateModel(opts: {
	apiKey: string
	model: string
	baseUrl?: string
	fetchFn?: typeof fetch
}): DelegateModel {
	const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
	const doFetch = opts.fetchFn ?? fetch
	return {
		async complete({ messages, tools, signal }) {
			const response = await doFetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				signal,
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
				body: JSON.stringify({
					model: opts.model,
					temperature: 0.2,
					max_tokens: 600,
					messages: messages.map((m) =>
						m.role === 'assistant'
							? {
									role: 'assistant',
									content: m.content,
									...(m.tool_calls?.length
										? {
												tool_calls: m.tool_calls.map((c) => ({
													id: c.id,
													type: 'function',
													function: { name: c.name, arguments: JSON.stringify(c.arguments) },
												})),
											}
										: {}),
								}
							: m,
					),
					tools: tools.map((t) => ({
						type: 'function',
						function: { name: t.name, description: t.description, parameters: t.parameters },
					})),
				}),
			})
			if (!response.ok) {
				throw new Error(`Delegate model error ${response.status}`)
			}
			const data = (await response.json()) as {
				choices?: Array<{
					message?: {
						content?: string | null
						tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
					}
				}>
			}
			const message = data.choices?.[0]?.message
			if (!message) throw new Error('Delegate model returned no message')
			return {
				text: message.content ?? null,
				toolCalls: (message.tool_calls ?? []).map((c) => {
					let args: unknown
					try {
						args = JSON.parse(c.function.arguments || '{}')
					} catch {
						args = {}
					}
					return {
						id: c.id,
						name: c.function.name,
						arguments:
							args && typeof args === 'object' && !Array.isArray(args)
								? (args as Record<string, unknown>)
								: {},
					}
				}),
			}
		},
	}
}

/** `core` (default): the voice model gets a small set plus ask_workspace. `full`: every tool, as before. */
export function resolveVoiceToolMode(env: NodeJS.ProcessEnv = process.env): 'core' | 'full' {
	return env.MASKIN_VOICE_TOOL_MODE?.trim().toLowerCase() === 'full' ? 'full' : 'core'
}

export function resolveVoiceDelegateModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.MASKIN_VOICE_DELEGATE_MODEL?.trim() || VOICE_DELEGATE_DEFAULT_MODEL
}
