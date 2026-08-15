import { z } from 'zod'
import type { createObjectSchema } from './objects'

/**
 * Shape of the workspace knowledge object written when a new user completes
 * the signup form (name / organization / role). This is the contract between
 * T2 (form submit, calls the builder) and T4 (Strategist research-on-signup
 * trigger, reads back the resulting knowledge object).
 *
 * Wire layout
 * - `type`            : 'knowledge' (uses the existing knowledge module)
 * - `status`          : 'validated' — direct user input, no review needed
 * - `title`           : `Signup context — {name}`
 * - `content`         : human-readable markdown with name / org / role
 * - `metadata.source` : 'signup_capture' — T4 filters knowledge objects on this
 * - `metadata.name|org|role` : structured copies so T4 doesn't parse content
 * - `metadata.summary`, `confidence`, `tags`, `last_validated_at`
 *   : standard knowledge fields (see extensions/knowledge/shared.ts)
 *
 * Linkage
 * - The owning workspace is `objects.workspace_id` (set by the API from the
 *   X-Workspace-Id header on the create call).
 * - The user who signed up is `objects.created_by` (the actor making the
 *   authenticated create call).
 * - No relationships-table edges are created here — the relationships table
 *   is object-to-object across the codebase, and there is no precedent for
 *   targeting actors or workspaces. T4 attaches its research-output knowledge
 *   to this object via an `about` edge.
 */

export const SIGNUP_CAPTURE_SOURCE = 'signup_capture' as const
export const SIGNUP_CAPTURE_STATUS = 'validated' as const
export const SIGNUP_CAPTURE_TAGS = ['context:user', 'context:company'] as const

/**
 * `metadata.source` value written on knowledge objects the Strategist produces
 * during signup research (the second stage — after `signup_capture` lands and
 * the Strategist reads it, before any council intake). The council event
 * trigger filters on this value: `knowledge.created` with `metadata.source ==
 * signup_research` fires `strategic-intake-review` in its signup-context branch
 * against the freshly-landed research cluster.
 */
export const SIGNUP_RESEARCH_SOURCE = 'signup_research' as const

/**
 * `metadata.source` value written on bets the council promote-door creates from
 * signup research. New in T2. Used by T3 to distinguish signup-driven draft
 * cards from council-cadence-promoted bets, and by T4 to include them in the
 * always-notify-Sebastian batched digest. `bet.metadata.source` is a free-form
 * JSONB field — there is no runtime enum on it — so this constant is the
 * canonical allow-list entry: seed-time producers and downstream readers
 * import this instead of hardcoding the string.
 */
export const SIGNUP_FIRST_BET_DRAFT_SOURCE = 'signup_first_bet_draft' as const

export const signupCaptureInputSchema = z.object({
	name: z.string().trim().min(1).max(200),
	organization: z.string().trim().min(1).max(200),
	role: z.string().trim().min(1).max(200),
})
export type SignupCaptureInput = z.infer<typeof signupCaptureInputSchema>

export type SignupCaptureKnowledge = z.infer<typeof createObjectSchema>

export function buildSignupCaptureKnowledge(input: SignupCaptureInput): SignupCaptureKnowledge {
	const { name, organization, role } = signupCaptureInputSchema.parse(input)
	return {
		type: 'knowledge',
		status: SIGNUP_CAPTURE_STATUS,
		title: `Signup context — ${name}`,
		content: [
			`**Name:** ${name}`,
			`**Organization:** ${organization}`,
			`**Role:** ${role}`,
			'',
			'_Captured at signup. Source of truth for new-workspace context._',
		].join('\n'),
		metadata: {
			source: SIGNUP_CAPTURE_SOURCE,
			name,
			organization,
			role,
			summary: `Signup context for ${name} — ${role} at ${organization}.`,
			confidence: 'high',
			tags: [...SIGNUP_CAPTURE_TAGS],
			last_validated_at: new Date().toISOString(),
		},
	}
}
