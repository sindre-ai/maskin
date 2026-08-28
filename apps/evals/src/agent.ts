import type Anthropic from '@anthropic-ai/sdk'
import type { ToolExecutor } from './executor'

/** One tool call the model made, and what came back. */
export interface ToolCall {
	name: string
	input: Record<string, unknown>
	result: string
	isError: boolean
}

export interface Trajectory {
	calls: ToolCall[]
	/** Assistant turns taken. */
	turns: number
	/** True when the loop stopped because it ran out of turns, not because the
	 * model was done. A model that never settles is a finding, not a pass. */
	hitTurnLimit: boolean
	/** The model's final prose, for a human reading a failed run. */
	finalText: string
	inputTokens: number
	outputTokens: number
}

export interface RunAgentOptions {
	client: Anthropic
	model: string
	systemPrompt: string
	tools: Anthropic.Tool[]
	prompt: string
	executor: ToolExecutor
	maxTurns: number
	effort: 'low' | 'medium' | 'high'
}

/**
 * Drive a real multi-turn tool-use loop: call the model, execute every
 * `tool_use` block it emits against the executor, feed the results back, and
 * repeat until it stops calling tools or runs out of turns.
 *
 * Tool results are returned verbatim, including errors, with `is_error` set.
 * Sanitising them would hide the behaviour worth measuring - whether a model
 * that gets a rejection reads it and recovers, or loops on the same bad call.
 */
export async function runAgent(opts: RunAgentOptions): Promise<Trajectory> {
	const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }]
	const calls: ToolCall[] = []
	let inputTokens = 0
	let outputTokens = 0
	let finalText = ''
	let turns = 0

	while (turns < opts.maxTurns) {
		turns++
		const response = await opts.client.messages.create({
			model: opts.model,
			max_tokens: 8192,
			output_config: { effort: opts.effort },
			system: opts.systemPrompt,
			tools: opts.tools,
			tool_choice: { type: 'auto' },
			messages,
		})
		inputTokens += response.usage.input_tokens
		outputTokens += response.usage.output_tokens

		const text = response.content
			.filter((block): block is Anthropic.TextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
		if (text) finalText = text

		const toolUses = response.content.filter(
			(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
		)
		if (toolUses.length === 0) {
			return { calls, turns, hitTurnLimit: false, finalText, inputTokens, outputTokens }
		}

		messages.push({ role: 'assistant', content: response.content })

		// Sequentially, not in parallel: these calls mutate one workspace, and a
		// create_loop racing the create_actor it depends on would fail for a
		// reason that has nothing to do with the tool descriptions under test.
		const results: Anthropic.ToolResultBlockParam[] = []
		for (const use of toolUses) {
			const input = (use.input ?? {}) as Record<string, unknown>
			const outcome = await opts.executor.call(use.name, input)
			calls.push({ name: use.name, input, result: outcome.text, isError: outcome.isError })
			results.push({
				type: 'tool_result',
				tool_use_id: use.id,
				content: outcome.text,
				is_error: outcome.isError,
			})
		}
		messages.push({ role: 'user', content: results })
	}

	return { calls, turns, hitTurnLimit: true, finalText, inputTokens, outputTokens }
}
