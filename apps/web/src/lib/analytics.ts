import type { CaptureOptions } from 'posthog-js'
import { getStoredActor } from './auth'
import { capture, isPosthogReady } from './posthog'

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>

export function trackEvent(
	name: string,
	props: AnalyticsProps = {},
	options?: CaptureOptions,
): void {
	try {
		capture(name, props, options)
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

// Kebab-cased role for the actor that opened the session. Fixed by the
// Chief of Staff prototype bet's `posthog_query`: `chief-of-staff` when the
// workspace's default agent routed the chat, otherwise the picked agent's
// role. Callers derive it via `deriveEntryAgentRole()` below.
export function trackChatSessionStarted(
	p: BaseProps & {
		entity_type: 'session'
		entry_point: ChatSessionEntryPoint
		entry_agent_role: string | null
	},
): void {
	trackEvent('chat_session_started', {
		...fillBase(p),
		entry_point: p.entry_point,
		entry_agent_role: p.entry_agent_role,
	})
}

// Fires when the owner picks a non-default agent from the slash-picker instead
// of letting the default (Chief of Staff, once T3 wires it) route the chat.
// One of the three thinness events for the Chief of Staff stub bet — a hit
// means the boundary agent was bypassed. `entity_id` is the picked agent's
// actor id so the query can group by which specialist was pulled in.
export function trackSpecialistSummonedManually(
	p: BaseProps & { entity_type: 'agent'; agent_role: string | null },
): void {
	trackEvent('specialist_summoned_manually', {
		...fillBase(p),
		agent_role: p.agent_role,
	})
}

// Kebab-cases an agent's display name into the role slug the PostHog query
// keys off. Returns `null` for a nameless or whitespace-only input so the
// property is explicitly missing rather than an empty string — the query
// `properties.entry_agent_role = 'chief-of-staff'` reads a null as "not the
// default", which is the correct semantic when the actor's identity is
// undetermined.
export function deriveEntryAgentRole(name: string | null | undefined): string | null {
	if (!name) return null
	const trimmed = name.trim()
	if (trimmed.length === 0) return null
	return trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
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
//
// Both events fire with `send_instantly: true` so posthog-js bypasses its
// ~3-second batching queue. The response event was being lost in prod because
// the card unmounts immediately after submit and users often tab away right
// after — the batched event never made it out of the browser, so the event
// name never even landed in the PostHog project taxonomy. The impression uses
// the same flag for parity: both halves of the ratio must have identical
// delivery semantics or the ship metric is biased.
export function trackNorthStarPromptImpression(p: { workspace_id: string }): void {
	trackEvent(
		'north_star_prompt_impression',
		{ workspace_id: p.workspace_id },
		{ send_instantly: true },
	)
}

export function trackNorthStarPromptResponse(p: { workspace_id: string }): void {
	trackEvent(
		'north_star_prompt_response',
		{ workspace_id: p.workspace_id },
		{ send_instantly: true },
	)
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

// Ship-metric events for the view-state retention bet on the Objects list.
// The PostHog query pairs `objects_list_arrived(nav_type='back')` (denominator
// — a back-nav landing on the list) with `objects_list_group_toggled(source=
// 'user')` (numerator — a user-initiated group toggle) within a 30s window,
// enforced on the query side. `nav_type` fires on every mount so the arrival
// stream can be sliced later; `direct` is a URL-bar or hard-refresh landing,
// `link` is an in-app SPA navigation. `source` distinguishes user toggles
// from the eventual system-driven restore (used to wire-verify the restore).
// `objectType` is the current tab (`bet`, `insight`, …) or `null` on the All
// tab so the metric can be sliced per type without joining super properties.
export type ObjectsListNavType = 'back' | 'direct' | 'link'

export function trackObjectsListArrived(p: {
	nav_type: ObjectsListNavType
	objectType: string | null
}): void {
	trackEvent('objects_list_arrived', { nav_type: p.nav_type, objectType: p.objectType })
}

export type ObjectsListGroupToggleSource = 'user' | 'system'

export function trackObjectsListGroupToggled(p: {
	source: ObjectsListGroupToggleSource
	expanded: boolean
	objectType: string | null
}): void {
	trackEvent('objects_list_group_toggled', {
		source: p.source,
		expanded: p.expanded,
		objectType: p.objectType,
	})
}

// Ship-metric event for the sticky-nav-hero bet. Fires once per completed
// scroll-to-top gesture on an object-detail page — the user must scroll ≥ 1
// viewport down inside the app scroll container and return near the top before
// the event emits. The parent bet's `metadata.posthog_query` pairs this event
// with `objects_control_changed` fired against the same entity within 10s to
// measure the scroll-to-top → property-edit bounce. Follows the
// `trackObjectCreated` taxonomy — `entity_id` + `entity_type='object'` +
// `object_subtype` — so the correlation join runs cleanly without aliasing and
// the schema stays forward-compatible for `insight`/`task` subtypes (Product
// Analyst signoff, 2026-07-20).
export function trackScrollToTop(
	p: BaseProps & {
		entity_type: 'object'
		object_subtype: string
		scroll_depth_at_start_px: number
		viewports_scrolled: number
	},
): void {
	trackEvent('scroll_to_top', {
		...fillBase(p),
		object_subtype: p.object_subtype,
		scroll_depth_at_start_px: p.scroll_depth_at_start_px,
		viewports_scrolled: p.viewports_scrolled,
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

// Ship-metric events for the bidirectional swipe-to-read/unread bet on the For
// You page. Fire on the *completed* swipe — inside the post-Undo timer commit,
// so tapping Undo within the 4.5s window emits nothing. `mobile` is computed at
// emission from `window.innerWidth <= 768` rather than snapshotted at hook mount
// because the DoD keys the mobile/desktop split off the viewport width the
// gesture actually completes on. `via` is fixed to 'swipe' so the toolbar
// mark-read button can be instrumented separately later without back-filling.
function isMobileViewport(): boolean {
	if (typeof window === 'undefined') return false
	return window.innerWidth <= 768
}

interface ForyouCardMarkedProps {
	entity_type: string
	entity_id: string
}

export function trackForyouCardMarkedRead(p: ForyouCardMarkedProps): void {
	trackEvent('foryou_card_marked_read', {
		entity_type: p.entity_type,
		entity_id: p.entity_id,
		mobile: isMobileViewport(),
		via: 'swipe',
	})
}

export function trackForyouCardMarkedUnread(p: ForyouCardMarkedProps): void {
	trackEvent('foryou_card_marked_unread', {
		entity_type: p.entity_type,
		entity_id: p.entity_id,
		mobile: isMobileViewport(),
		via: 'swipe',
	})
}

// Ship-metric event for the object-detail sidebar bet. Fires on every open and
// every close of the right sidebar in `ObjectDocument`. `state` is the state
// being transitioned TO; `viewport` matches the workspace's 375 / 768 / 1024
// breakpoints (<768 mobile, 768–1023 tablet, ≥1024 desktop) so the metric can
// be sliced per form factor without joining super properties. The bet's exit
// gate revokes the feature if this event stays at 0/day across all dogfooders
// for 7 consecutive days — so it must fire from every open/close path.
export type SidebarToggleState = 'open' | 'closed'
export type SidebarViewport = 'mobile' | 'tablet' | 'desktop'

export function trackSidebarToggle(p: {
	state: SidebarToggleState
	viewport: SidebarViewport
	object_id: string
}): void {
	trackEvent('sidebar_toggle', {
		state: p.state,
		viewport: p.viewport,
		object_id: p.object_id,
	})
}

// Maps a CSS-pixel width to the ship-metric viewport bucket. Boundaries are
// <768 / 768–1023 / ≥1024, matching the bet's chosen breakpoints and the
// `md`/`lg` Tailwind tokens. Callers pass `window.innerWidth`; the SSR fallback
// (no `window`) resolves to `desktop` so the event still ships with a value
// rather than dropping the property.
export function deriveSidebarViewport(width: number): SidebarViewport {
	if (width < 768) return 'mobile'
	if (width < 1024) return 'tablet'
	return 'desktop'
}
