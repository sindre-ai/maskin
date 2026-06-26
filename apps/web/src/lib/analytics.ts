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

type TaxonomyEntityType =
	| 'bet'
	| 'task'
	| 'insight'
	| 'knowledge'
	| 'meeting'
	| 'session'
	| 'trigger'
	| 'relationship'
	| 'file'

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
	p: BaseProps & { is_reply: boolean; attachment_count: number; content: string },
): void {
	trackEvent('comment_posted', {
		...fillBase(p),
		is_reply: p.is_reply,
		attachment_count: p.attachment_count,
		content: p.content,
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

// For You sparse-state composer. `items_count` is the rendered item count on
// the For You feed at the moment of the event (0–2 for the sparse range).
// `workspace_id` rides via PostHog super-properties registered on workspace
// mount — do not pass it explicitly.

export function trackForyouSparseComposerShown(p: { items_count: number }): void {
	trackEvent('foryou_sparse_composer_shown', { items_count: p.items_count })
}

export function trackForyouSparseComposerSubmit(p: { items_count: number }): void {
	trackEvent('foryou_sparse_composer_submit', { items_count: p.items_count })
}

// iPadOS 13+ reports `MacIntel` from `navigator.userAgent` / `navigator.platform`
// and only the `maxTouchPoints > 1` signal distinguishes it from a real Mac, so
// the touch-point check is load-bearing — not paranoia. Returning 'web' for
// everything else (including Android) is deliberate: the bet's success metric
// filters on `platform=ios`, and conflating Android into iOS would skew it.
function detectPlatform(): 'ios' | 'web' {
	if (typeof navigator === 'undefined') return 'web'
	const ua = navigator.userAgent ?? ''
	if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
	if (ua.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1) return 'ios'
	return 'web'
}

export function trackChatImageUpload(p: { outcome: 'success' | 'failure' }): void {
	trackEvent('chat_image_upload', { platform: detectPlatform(), outcome: p.outcome })
}
