import type { MessageMetadata } from '@/lib/api'
import {
	type NeededTool,
	type SuggestedStep,
	neededToolsSchema,
	suggestedStepsSchema,
} from '@maskin/shared'

/**
 * What an agent intro's metadata asks the web to draw. Null for a message that
 * carries none of the intro keys, or when any key it does carry fails to parse:
 * then the plain body shows in full and nothing is drawn, so the intro always
 * reads complete.
 */
export interface IntroView {
	steps: SuggestedStep[] | null
	tools: NeededTool[] | null
	/** Trailing paragraphs of the body that the buttons and rows replace. */
	plainTail: number
}

export function parseIntroView(metadata: MessageMetadata | null | undefined): IntroView | null {
	if (!metadata) return null
	const { suggested_steps, needed_tools, plain_tail } = metadata
	if (suggested_steps === undefined && needed_tools === undefined) return null

	let steps: SuggestedStep[] | null = null
	if (suggested_steps !== undefined) {
		const parsed = suggestedStepsSchema.safeParse(suggested_steps)
		if (!parsed.success) return null
		steps = parsed.data
	}
	let tools: NeededTool[] | null = null
	if (needed_tools !== undefined) {
		const parsed = neededToolsSchema.safeParse(needed_tools)
		if (!parsed.success) return null
		tools = parsed.data
	}
	if (!Number.isInteger(plain_tail) || (plain_tail as number) < 0) return null
	return { steps, tools, plainTail: plain_tail as number }
}

/**
 * The body without its last `count` paragraphs (the plain list, the tools
 * sentence and the closing line). Paragraphs are blank-line separated. Returns
 * the body untouched when the count does not leave at least one paragraph, so a
 * wrong count can only show too much, never cut the greeting.
 */
export function dropPlainTail(content: string, count: number): string {
	if (count <= 0) return content
	const paragraphs = content.split(/\n{2,}/)
	if (count >= paragraphs.length) return content
	return paragraphs.slice(0, paragraphs.length - count).join('\n\n')
}
