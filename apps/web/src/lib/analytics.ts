import { getStoredActor } from './auth'
import { capture, isPosthogReady } from './posthog'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

export function trackEvent(name: string, props: AnalyticsProps = {}): void {
	try {
		if (isPosthogReady()) {
			capture(name, props)
			return
		}
		const actor = getStoredActor()
		const payload = {
			ts: new Date().toISOString(),
			name,
			actorId: actor?.id ?? null,
			...props,
		}
		console.info('[analytics]', payload)
	} catch {
		// Analytics must never break the UI.
	}
}

// Typed helpers for the v1 PostHog event taxonomy (bet + agent loop). Super
// properties `workspace_id` / `actor_id` / `actor_type` are registered once
// per workspace mount and travel on every capture, so call sites only supply
// the per-event contract: entity_id, entity_type, source, flow_id, plus any
// event-specific fields.

export type TaxonomyEntityType =
	| 'bet'
	| 'task'
	| 'insight'
	| 'knowledge'
	| 'meeting'
	| 'session'
	| 'trigger'
	| 'relationship'
	| 'file'

export function isTaxonomyEntityType(s: string): s is TaxonomyEntityType {
	const valid = [
		'bet',
		'task',
		'insight',
		'knowledge',
		'meeting',
		'session',
		'trigger',
		'relationship',
		'file',
	] satisfies TaxonomyEntityType[]
	return valid.includes(s as TaxonomyEntityType)
}

type EventSource = 'web' | 'mcp' | 'trigger'

interface BaseProps {
	entity_id: string
	entity_type: TaxonomyEntityType
	source?: EventSource
	flow_id?: string | null
}

function fillBase(p: BaseProps): AnalyticsProps {
	return {
		entity_id: p.entity_id,
		entity_type: p.entity_type,
		source: p.source ?? 'web',
		flow_id: p.flow_id ?? null,
	}
}

export function trackBetCreated(p: BaseProps & { entity_type: 'bet' }): void {
	trackEvent('bet_created', fillBase(p))
}

export function trackBetStatusChanged(
	p: BaseProps & { entity_type: 'bet' | 'task' | 'insight'; from: string; to: string },
): void {
	trackEvent('bet_status_changed', { ...fillBase(p), from: p.from, to: p.to })
}

export function trackBetArchived(p: BaseProps & { entity_type: 'bet' }): void {
	trackEvent('bet_archived', fillBase(p))
}

export function trackAgentSessionStarted(p: BaseProps & { entity_type: 'session' }): void {
	trackEvent('agent_session_started', fillBase(p))
}

export function trackAgentSessionCompleted(
	p: BaseProps & { entity_type: 'session'; outcome: 'completed' | 'failed' | 'timeout' },
): void {
	trackEvent('agent_session_completed', { ...fillBase(p), outcome: p.outcome })
}

export function trackCommentPosted(
	p: BaseProps & { is_reply: boolean; attachment_count: number },
): void {
	trackEvent('comment_posted', {
		...fillBase(p),
		is_reply: p.is_reply,
		attachment_count: p.attachment_count,
	})
}

export function trackTriggerFired(p: BaseProps & { entity_type: 'trigger' }): void {
	trackEvent('trigger_fired', { ...fillBase(p), source: 'trigger' })
}

export function trackRelationshipCreated(
	p: BaseProps & { entity_type: 'relationship'; relationship_type: string },
): void {
	trackEvent('relationship_created', { ...fillBase(p), relationship_type: p.relationship_type })
}

export function trackObjectAttachedFile(
	p: BaseProps & { file_id: string; parent_entity_type: TaxonomyEntityType },
): void {
	trackEvent('object_attached_file', {
		...fillBase(p),
		file_id: p.file_id,
		parent_entity_type: p.parent_entity_type,
	})
}
