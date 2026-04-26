import { z } from 'zod'

/**
 * Trailing call-to-action attached to a headline when the model (or the
 * rule-based fallback) decides the captain should be nudged toward an action
 * (e.g. unresolved decisions, an offline agent). The headline reads naturally
 * without it; the CTA is rendered as a trailing link.
 */
export const headlineCtaSchema = z.object({
	text: z.string().min(1).max(40),
	href: z.string().min(1),
})

/**
 * One short sentence describing today's state of the AI team. Constrained to
 * present tense, no markdown, ≤140 chars — the strip is the most important
 * pixel on the dashboard and must never overflow on narrow viewports.
 */
export const headlineResponseSchema = z.object({
	headline: z.string().min(1).max(140),
	cta: headlineCtaSchema.optional(),
	generatedAt: z.string(),
	source: z.enum(['llm', 'fallback']),
})

export type HeadlineCta = z.infer<typeof headlineCtaSchema>
export type HeadlineResponse = z.infer<typeof headlineResponseSchema>
