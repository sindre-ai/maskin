import { getStoredActor } from './auth'
import { capture, isPosthogReady } from './posthog'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

export function trackEvent(name: string, props: AnalyticsProps = {}): void {
	try {
		capture(name, props)
	} catch {
		// Analytics must never break the UI.
	}
	if (isPosthogReady()) return
	try {
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
	| 'object'
	| 'agent'
	| 'bet'
	| 'task'
	| 'insight'
	| 'knowledge'
	| 'meeting'
	| 'session'
	| 'trigger'
	| 'relationship'
	| 'file'
	| 'loop'

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

// Fires on server-confirmed create for the three CreatePicker paths. Payload
// shape mirrors `bet_created` so `object_create_completion_rate_60s` can pair
// the create event with the first title/field edit against the same entity_id.
// `object_subtype` carries the object's `type` column (bet/insight/…), since
// entity_type is fixed to 'object' for the taxonomy row.

export function trackObjectCreated(
	p: BaseProps & { entity_type: 'object'; object_subtype: string },
): void {
	trackEvent('object_created', { ...fillBase(p), object_subtype: p.object_subtype })
}

export function trackAgentCreated(p: BaseProps & { entity_type: 'agent' }): void {
	trackEvent('agent_created', fillBase(p))
}

export function trackTriggerCreated(p: BaseProps & { entity_type: 'trigger' }): void {
	trackEvent('trigger_created', fillBase(p))
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

// Operator opened a chat with Maskin (Sindre, or a one-shot agent via the `/`
// picker). Powers the founder-substitution measurement on the
// `Chat — Maskin becomes the operator's default AI client` bet: counted against
// surveyed Claude / ChatGPT session starts to track displacement over time.
// `entity_id` is the container session id so PostHog can join back to the
// sessions table. `workspace_id` + `actor_id` ride as super-properties.
export type ChatSessionEntryPoint = 'sindre_session' | 'agent_one_shot'

export function trackChatSessionStarted(
	p: BaseProps & { entity_type: 'session'; entry_point: ChatSessionEntryPoint },
): void {
	trackEvent('chat_session_started', { ...fillBase(p), entry_point: p.entry_point })
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

// Sidebar legibility bet — click-through proxy for the qualitative ship metric.
// `workspace_id` already rides via the PostHog super-property registered on
// workspace mount; the explicit `workspaceId` here is a duplicate the Analyst
// asked for so the events can be sliced without joining super-properties.

export function trackSidebarWorkspaceSwitcherOpened(p: { workspaceId: string }): void {
	trackEvent('sidebar.workspace_switcher.opened', { workspaceId: p.workspaceId })
}

export function trackSidebarAgentActivityExpanded(p: { workspaceId: string }): void {
	trackEvent('sidebar.agent_activity.expanded', { workspaceId: p.workspaceId })
}

// Ship-metric events for the For You onboarding prompt bet — response rate =
// count(north_star_prompt_response) / count(north_star_prompt_impression),
// filtered to workspaces with no prior bets. `workspace_id` is passed on the
// event (not via super properties) so the PostHog cohort filter can key off it
// without depending on the workspace mount having already registered.
export function trackNorthStarPromptImpression(p: { workspace_id: string }): void {
	trackEvent('north_star_prompt_impression', { workspace_id: p.workspace_id })
}

export function trackNorthStarPromptResponse(p: { workspace_id: string }): void {
	trackEvent('north_star_prompt_response', { workspace_id: p.workspace_id })
}

// Ship-metric event for the iOS bulk-select ergonomics bet. Fires once per
// bulk action bar commit so we can read `avg(selected_count)` filtered by
// `platform_device='ios'` in PostHog. Intentionally lighter than the v1
// taxonomy helpers above — there's no `entity_id` because the commit spans
// many objects; `selected_count` carries the n instead.
export type BulkEditCommitAction = 'status_change' | 'owner_change' | 'copy' | 'delete'
export type PlatformDevice = 'ios' | 'android' | 'desktop'

export function trackBulkEditCommit(p: {
	selected_count: number
	action: BulkEditCommitAction
	platform_device: PlatformDevice
}): void {
	trackEvent('bulk_edit_commit', {
		selected_count: p.selected_count,
		action: p.action,
		platform_device: p.platform_device,
		source: 'web',
	})
}

// Ship-metric events for the Loops primitive bet. `loop_viewed` fires once per
// Loop detail page mount; `loop_graduated` fires once per Loop created from the
// web (paired with `bet_created` — same call site pattern in `useCreateObject`).
// `source_bet_id` mirrors the Loop's `metadata.source_bet_id` so PostHog can
// join Loop reads back to the bet that produced them.
export function trackLoopViewed(
	p: BaseProps & { entity_type: 'loop'; source_bet_id: string | null },
): void {
	trackEvent('loop_viewed', { ...fillBase(p), source_bet_id: p.source_bet_id })
}

export function trackLoopGraduated(
	p: BaseProps & { entity_type: 'loop'; source_bet_id: string | null },
): void {
	trackEvent('loop_graduated', { ...fillBase(p), source_bet_id: p.source_bet_id })
}
