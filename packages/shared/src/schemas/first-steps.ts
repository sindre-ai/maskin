import { z } from 'zod'

// Lives in its own file, not in actors.ts: conversations.ts (the stored intro steps) and
// actors.ts (the creator's first_steps) both need it, and actors.ts reaches
// conversations.ts through sessions.ts, so importing it from there would be a cycle.

/** Plain text only: a control character, which includes a newline, is rejected. */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

const planText = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine((text) => !hasControlCharacter(text), 'No control characters or line breaks')

/**
 * One first step a creator writes for a new agent. Not trimmed: a fill step may
 * end in a space on purpose ("Here is a first task for you: "). A send step is
 * sent as written the moment it is tapped, so what the person reads on the
 * button must be exactly what is sent: prompt equals label, no trailing space.
 */
export const firstStepSchema = z
	.object({
		label: planText(60),
		prompt: planText(200),
		action: z.enum(['send', 'fill']),
	})
	.superRefine((step, ctx) => {
		if (step.action !== 'send') return
		if (step.prompt.trim() !== step.label.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prompt'],
				message: 'A send step must have the same words in prompt and label',
			})
		}
		if (/\s$/.test(step.prompt)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prompt'],
				message: 'A send step must not end in a space',
			})
		}
	})

export type FirstStep = z.infer<typeof firstStepSchema>
