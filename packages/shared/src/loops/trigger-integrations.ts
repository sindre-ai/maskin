/**
 * Static `triggerKind → requiredIntegrations[]` map. Same import used by the
 * D9 `LoopPlanCard` (frontend, to render the "NEEDS THESE CONNECTED" row) and
 * by the `trigger-runner` create-time validation (backend, to reject a
 * trigger whose owning workspace has not connected the providers it needs).
 * One module = one source of truth; the two callsites can never diverge.
 *
 * ## Scope
 *
 * "Trigger kind" here is the `triggerTypeSchema` value from
 * `../schemas/triggers.ts` — the discriminant on `triggers.type`. The live
 * schema declares three: `cron`, `event`, `reminder`. None of them
 * intrinsically requires a third-party integration to fire — a cron fires on
 * schedule, an event fires on a workspace event, a reminder fires on a
 * scheduled_at wall clock. The map therefore ships with every kind mapped to
 * `[]`; a future kind (e.g. an inbound-webhook trigger) would add its own
 * entry with the provider(s) that must be connected for it to receive.
 *
 * ## Discrepancy note
 *
 * The bet SPEC ("Loops & Loop detail — v4 UX/UI polish", D9 section) refers
 * to "the four trigger kinds we have today". The live trigger-runner + the
 * `triggerTypeSchema` in `packages/shared/src/schemas/triggers.ts` declare
 * three (`cron`, `event`, `reminder`), and `triggers.test.ts` explicitly
 * rejects a fourth (`'webhook'`). This module ships with all three current
 * kinds — the SPEC's "four" reads as stale. Flagged in the PR body so the
 * bet's driver can reconcile the SPEC (or reintroduce the fourth kind under
 * a separate task) rather than have the module guess.
 *
 * ## Not a server endpoint
 *
 * Per SPEC Q3, the map is deliberately a static frontend/shared constant, not
 * a `GET /api/trigger-integrations` endpoint. Promotion to a server endpoint
 * is reserved for a follow-on bet if the map churns or exceeds ~7 kinds.
 */

import type { z } from 'zod'
import type { triggerTypeSchema } from '../schemas/triggers'

/**
 * Alias for the trigger-kind discriminant. Sourced from
 * `triggerTypeSchema` so the union here can never drift from the schema
 * (adding a fourth kind there without extending the map below produces a
 * type error at the `satisfies` line).
 */
export type TriggerKind = z.infer<typeof triggerTypeSchema>

/**
 * Integration provider names — kept as free strings on purpose. The canonical
 * list lives in `apps/dev/src/lib/integrations/registry.ts`; duplicating a
 * union of provider names here would drift the moment a provider is added or
 * renamed. `KNOWN_PROVIDERS` in `packages/mcp/src/setup-guidance/providers.ts`
 * makes the same call for the same reason.
 */
export type IntegrationName = string

export const TRIGGER_INTEGRATIONS = {
	cron: [],
	event: [],
	reminder: [],
} as const satisfies Record<TriggerKind, readonly IntegrationName[]>

/**
 * Convenience accessor. Returns `[]` for a kind that isn't in the map, which
 * lets D9's LoopPlanCard render "no integrations required" for a future kind
 * that ships before this map catches up — a soft-fail is safer here than a
 * throw that blacks out the plan card.
 */
export function requiredIntegrationsFor(kind: string): readonly IntegrationName[] {
	return (TRIGGER_INTEGRATIONS as Record<string, readonly IntegrationName[]>)[kind] ?? []
}
