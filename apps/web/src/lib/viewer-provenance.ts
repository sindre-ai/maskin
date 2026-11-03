// Provenance branch resolution for the file viewer.
//
// The viewer calls `useAttachingObjects(fileId)` which wraps
// `list_relationships({ target_id: fileId, type: 'attached' })`, filtered to
// non-archived server-side. That returns a list of AttachingObject rows —
// their shape is documented below. This module turns that list into the
// crumb + strip + send-state contract the UI renders.
//
// The 6 variants (spec §Provenance strip):
//   1. single   — one non-archived attacher
//   2. pair     — two non-archived attachers, arrived-from framing
//   3. many     — >2 non-archived attachers, picker required before send
//   4. zero     — no attaching objects (direct link)
//   5. archived — every attacher archived
//   6. orphaned — the attacher was archived mid-review (server returned
//                 targetArchived on the edge). Same UI as archived, but the
//                 label is "orphaned + re-attach" per §Provenance strip.
//
// Plus the agent-attached-human-driver special case: still routes to the
// human driver via the single-driver rule; server-side rule holds, this
// module just carries the driverType through so the panel can render the
// 🔒 Awaiting agent response lock correctly on the OTHER branch (agent
// driver). See viewer-analytics.ts for how it affects send-state.

export type ObjectType = 'bet' | 'task' | 'insight' | 'meeting' | 'file' | 'loop' | 'session'

export type DriverType = 'human' | 'agent'

// One row from useAttachingObjects — an object that attaches this file.
export interface AttachingObject {
	id: string
	title: string
	type: ObjectType
	driverId: string | null
	driverType: DriverType | null
	attacherName: string
	attachedAt: string // ISO
	// Server returns true when the object was archived after the edge was
	// created (i.e. archived mid-review). The 'orphaned' variant fires.
	targetArchived: boolean
	// Server marks archived-from-the-start attachers as archived: true and
	// filters them by default. When the client asks for the full list (for
	// the "Attached to (archived)" strip in variant #5) they come through with
	// this flag set.
	archived: boolean
}

export type ProvenanceVariant = 'single' | 'pair' | 'many' | 'zero' | 'archived' | 'orphaned'

export type SendState = 'enabled' | 'picker-required' | 'disabled'

export interface ProvenanceCrumb {
	// The crumb prefix rendered before the filename. `null` means no prefix.
	// - single → the attaching object
	// - pair   → dropdown listing both, the "arrived-from" one is preselected
	// - many   → "Multiple objects" collapsed dropdown, listing all
	// - zero   → null
	// - archived / orphaned → the archived attacher (rendered muted)
	prefix:
		| null
		| { kind: 'single'; object: AttachingObject }
		| { kind: 'dropdown'; options: AttachingObject[]; preselectedId: string | null }
		| { kind: 'collapsed'; options: AttachingObject[] }
		| { kind: 'archived'; object: AttachingObject }
}

export interface ProvenanceStrip {
	kind: 'single' | 'pair' | 'many' | 'archived' | 'orphaned' | 'hidden'
	// The attacher(s) to render, if any. `hidden` (variant #4 zero-attach)
	// has no strip.
	objects: AttachingObject[]
	// UI-ready label. The renderer applies its own tone from `kind` — this is
	// the text-only string so tests can assert it directly.
	label: string | null
}

export interface ProvenanceResolution {
	variant: ProvenanceVariant
	crumb: ProvenanceCrumb
	strip: ProvenanceStrip
	send: SendState
	// Populated for the 'many' variant. Picker options are the non-archived
	// attachers — the user has to pick one before Send enables.
	pickerOptions: AttachingObject[]
	// The object the round would target if `send === 'enabled'`. For 'many'
	// it stays `null` until the user picks in the UI.
	defaultTarget: AttachingObject | null
	// Convenience surface for the "🔒 Awaiting agent response" lock: what
	// kind of driver would receive the round if fired right now?
	// null on 'zero' / 'archived' / 'orphaned' / 'many' pre-pick.
	targetDriverType: DriverType | null
}

// Deterministic resolver. Input is the raw list from
// `list_relationships({ target_id: fileId, type: 'attached' })` — including
// archived rows (they arrive with `archived: true` or `targetArchived: true`).
// This function is pure so it's unit-testable across every branch without
// mounting React.
export function resolveProvenance(attachers: AttachingObject[]): ProvenanceResolution {
	// Variant #6 — orphaned mid-review. A single edge came back with
	// targetArchived: true. Precedence over 'archived' because it drives a
	// distinct label ("orphaned + re-attach") per spec.
	const orphaned = attachers.filter((a) => a.targetArchived)
	if (orphaned.length > 0 && orphaned.length === attachers.length) {
		return {
			variant: 'orphaned',
			crumb: { prefix: { kind: 'archived', object: orphaned[0] } },
			strip: {
				kind: 'orphaned',
				objects: orphaned,
				label: `Orphaned: ${orphaned[0].title} — re-attach`,
			},
			send: 'disabled',
			pickerOptions: [],
			defaultTarget: null,
			targetDriverType: null,
		}
	}

	const live = attachers.filter((a) => !a.archived && !a.targetArchived)
	const archived = attachers.filter((a) => a.archived && !a.targetArchived)

	// Variant #4 — zero attaching objects (direct link).
	if (attachers.length === 0) {
		return {
			variant: 'zero',
			crumb: { prefix: null },
			strip: { kind: 'hidden', objects: [], label: null },
			send: 'disabled',
			pickerOptions: [],
			defaultTarget: null,
			targetDriverType: null,
		}
	}

	// Variant #5 — every attacher archived (from the start). Only-archived is
	// treated as effectively zero for send purposes, but the strip carries
	// the archived label per spec.
	if (live.length === 0 && archived.length > 0) {
		return {
			variant: 'archived',
			crumb: { prefix: { kind: 'archived', object: archived[0] } },
			strip: {
				kind: 'archived',
				objects: archived,
				label: `Attached to (archived): ${archived[0].title}`,
			},
			send: 'disabled',
			pickerOptions: [],
			defaultTarget: null,
			targetDriverType: null,
		}
	}

	// Variant #1 — one non-archived attacher.
	if (live.length === 1) {
		const only = live[0]
		return {
			variant: 'single',
			crumb: { prefix: { kind: 'single', object: only } },
			strip: {
				kind: 'single',
				objects: [only],
				label: `Attached to ${only.title} — ${only.attacherName}`,
			},
			send: 'enabled',
			pickerOptions: [],
			defaultTarget: only,
			targetDriverType: only.driverType,
		}
	}

	// Variant #2 — exactly two non-archived attachers.
	if (live.length === 2) {
		// Preselect the more recently attached one as "arrived-from"; the UI
		// offers a Switch context affordance to flip.
		const sorted = [...live].sort((a, b) => (a.attachedAt < b.attachedAt ? 1 : -1))
		const preselected = sorted[0]
		return {
			variant: 'pair',
			crumb: {
				prefix: { kind: 'dropdown', options: sorted, preselectedId: preselected.id },
			},
			strip: {
				kind: 'pair',
				objects: sorted,
				label: `Attached to ${preselected.title}`,
			},
			send: 'enabled',
			pickerOptions: sorted,
			defaultTarget: preselected,
			targetDriverType: preselected.driverType,
		}
	}

	// Variant #3 — many (>2). Picker required BEFORE Send enables; no silent
	// default so a review round never fires against the wrong object.
	return {
		variant: 'many',
		crumb: { prefix: { kind: 'collapsed', options: live } },
		strip: {
			kind: 'many',
			objects: live,
			label: `Attached to ${live.length} objects`,
		},
		send: 'picker-required',
		pickerOptions: live,
		defaultTarget: null,
		targetDriverType: null,
	}
}

// After the user picks in the many-attachers picker, the send transitions to
// 'enabled' targeting the picked object. Kept separate so the picker UI
// doesn't have to re-run the full resolver.
export function pickTarget(resolved: ProvenanceResolution, targetId: string): ProvenanceResolution {
	if (resolved.variant !== 'many' && resolved.variant !== 'pair') return resolved
	const target = resolved.pickerOptions.find((o) => o.id === targetId)
	if (!target) return resolved
	return {
		...resolved,
		send: 'enabled',
		defaultTarget: target,
		targetDriverType: target.driverType,
	}
}
