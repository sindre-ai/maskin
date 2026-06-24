import { z } from 'zod'
import type { createObjectSchema, updateObjectSchema } from './objects'
import type { SafeMetadata } from './primitives'

/**
 * Shape of knowledge objects written by the Strategist research-on-signup
 * trigger (`metadata.source === 'signup_research'`). T4 in the
 * Signup capture + default agents bet.
 *
 * Auto-researched facts go stale fast (B2B data decays ~2%/month) and many are
 * single-source pattern-guesses, so each fact carries provenance, a confidence
 * score (0–1), and bi-temporal validity. Contradicting facts INVALIDATE the
 * old row by setting `metadata.valid_to` and pointing a new row's
 * `metadata.supersedes` at the old id — they never overwrite in place. This is
 * the Zep/Graphiti pattern ratified in knowledge 2513885e.
 *
 * Wire layout (all extra fields ride on `metadata`; no DB migration):
 * - `metadata.source`               — full URL or provider id (e.g. 'web:tavily', 'crunchbase')
 * - `metadata.claim`                — short factual statement that this row asserts
 * - `metadata.confidence_score`     — number in [0,1]; ≥0.9 only for independent multi-source agreement
 * - `metadata.confidence`           — enum 'low' | 'medium' | 'high' (kept for the existing
 *                                     knowledge module display; derived from confidence_score)
 * - `metadata.staleness_class`      — 'short' (funding / headcount / current-challenge) or
 *                                     'long' (industry / mission)
 * - `metadata.valid_from`           — ISO instant when the fact started being true in the world
 * - `metadata.valid_to`             — ISO instant when it stopped (or null while current)
 * - `metadata.ingested_at`          — ISO instant the system learned the fact
 * - `metadata.supersedes`           — UUID of the row this one invalidates (or null)
 *
 * Status routing (the `route by confidence` rule):
 * - `confidence_score >= 0.6`       — status 'validated': informs bets directly
 * - `confidence_score <  0.6`       — status 'draft':     surfaces to the owner for
 *                                                        confirmation, does not inform bets silently
 *
 * Linkage:
 * - Per the architect's three-layer ruling, each signup-research knowledge object also
 *   takes an `about → actor` edge so the workspace owner can be queried from facts about
 *   them. That edge is created by the trigger via `create_relationships`, not by this
 *   schema. Ownership/workspace ride on the existing `workspace_id` / `created_by` columns.
 */

export const SIGNUP_RESEARCH_SOURCE = 'signup_research' as const

export const SHORT_STALENESS_CLASS = 'short' as const
export const LONG_STALENESS_CLASS = 'long' as const
export const STALENESS_CLASSES = [SHORT_STALENESS_CLASS, LONG_STALENESS_CLASS] as const
export type StalenessClass = (typeof STALENESS_CLASSES)[number]

/**
 * Threshold above which a research fact is trusted enough to inform a bet
 * directly. Below this, the row is written with status='draft' so the owner
 * sees it but downstream agents do not silently fold it into bet drafts.
 */
export const CONFIDENCE_ROUTING_THRESHOLD = 0.6

const isoInstantSchema = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO instant')

export const signupResearchInputSchema = z
	.object({
		claim: z.string().trim().min(1).max(500),
		source: z.string().trim().min(1).max(500),
		confidenceScore: z.number().min(0).max(1),
		stalenessClass: z.enum(STALENESS_CLASSES),
		validFrom: isoInstantSchema,
		validTo: isoInstantSchema.nullable().optional(),
		ingestedAt: isoInstantSchema.optional(),
		supersedes: z.string().uuid().nullable().optional(),
		title: z.string().trim().min(1).max(200),
		content: z.string().min(1),
		tags: z.array(z.string().min(1)).optional(),
	})
	.refine((v) => v.validTo === null || v.validTo === undefined || v.validTo >= v.validFrom, {
		message: 'valid_to must be on or after valid_from',
		path: ['validTo'],
	})
export type SignupResearchInput = z.infer<typeof signupResearchInputSchema>

export type SignupResearchKnowledge = z.infer<typeof createObjectSchema>

/** Numeric → enum bucket. Kept in lockstep with extensions/knowledge/shared.ts. */
export function bucketConfidence(score: number): 'low' | 'medium' | 'high' {
	if (score >= 0.8) return 'high'
	if (score >= 0.5) return 'medium'
	return 'low'
}

/**
 * Status the row should be written with given its confidence score.
 * High → 'validated' (informs bets). Low → 'draft' (surfaces to owner only).
 */
export function statusForConfidence(score: number): 'validated' | 'draft' {
	return score >= CONFIDENCE_ROUTING_THRESHOLD ? 'validated' : 'draft'
}

export function buildSignupResearchKnowledge(input: SignupResearchInput): SignupResearchKnowledge {
	const parsed = signupResearchInputSchema.parse(input)
	const ingestedAt = parsed.ingestedAt ?? new Date().toISOString()
	const metadata: SafeMetadata = {
		source: SIGNUP_RESEARCH_SOURCE,
		provenance_source: parsed.source,
		claim: parsed.claim,
		confidence_score: parsed.confidenceScore,
		confidence: bucketConfidence(parsed.confidenceScore),
		staleness_class: parsed.stalenessClass,
		valid_from: parsed.validFrom,
		valid_to: parsed.validTo ?? null,
		ingested_at: ingestedAt,
		supersedes: parsed.supersedes ?? null,
		summary: parsed.claim,
		tags: parsed.tags ?? ['context:company'],
		last_validated_at: ingestedAt,
	}
	return {
		type: 'knowledge',
		status: statusForConfidence(parsed.confidenceScore),
		title: parsed.title,
		content: parsed.content,
		metadata,
	}
}

/**
 * Produce the `updateObjectSchema` patch that invalidates an existing
 * signup-research row when a contradicting fact arrives. The caller writes
 * the new row separately (with `metadata.supersedes` pointing at the old id)
 * and creates a `supersedes` relationship edge — overwriting the content of
 * the old row is the bug this helper exists to prevent.
 */
export function buildInvalidationPatch(
	options: { validTo?: string } = {},
): z.infer<typeof updateObjectSchema> {
	const validTo = options.validTo ?? new Date().toISOString()
	return {
		status: 'deprecated',
		metadata: {
			valid_to: validTo,
		},
	}
}

/**
 * "As of" filter — returns rows that were valid at the given instant, dropping
 * rows that were superseded before then or that had not yet started. Use this
 * client-side after fetching the candidate set; the server stores everything.
 *
 * A row is "valid at T" when:
 *   valid_from <= T  AND  (valid_to IS NULL OR valid_to > T)
 */
export function isValidAt(
	row: { metadata?: Record<string, unknown> | null | undefined },
	asOf: string | Date,
): boolean {
	const meta = row.metadata ?? {}
	const validFrom = meta.valid_from as string | undefined
	const validTo = (meta.valid_to as string | null | undefined) ?? null
	if (!validFrom) return false
	const t = typeof asOf === 'string' ? asOf : asOf.toISOString()
	if (validFrom > t) return false
	if (validTo !== null && validTo !== undefined && validTo <= t) return false
	return true
}
