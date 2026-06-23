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
 * Tag stamped on every knowledge object written by the Strategist
 * research-on-signup trigger. The bet measures ≥1 useful object with this
 * source landing within 24h of signup as the ship metric, so the literal is
 * load-bearing — keep it stable.
 */
export const SIGNUP_RESEARCH_SOURCE = 'signup_research' as const

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
