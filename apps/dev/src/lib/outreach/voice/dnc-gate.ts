import { z } from '@hono/zod-openapi'
import { type ErasureKey, computeErasureMarker } from './erasure-key'
import type { VoiceContact } from './state'
import { DIAL_WINDOW_END_HOUR, DIAL_WINDOW_START_HOUR, copenhagenParts } from './workdays'

/**
 * Voice DNC gate. A new voice case, not an extension of the workspace skill
 * sebastian-do-not-contact (that is a prompt-level skill for the Sales Rep, not
 * repo code, and is untouched). Fail closed everywhere: a missing, malformed or
 * unreadable input refuses the dial with a reason a human can read.
 */

function meta(contact: VoiceContact): Record<string, unknown> {
	return contact.metadata ?? {}
}

/** A metadata value that counts as "set": anything but unset, null, false or an empty string. */
function isSet(v: unknown): boolean {
	return v !== undefined && v !== null && v !== false && v !== ''
}

function holdReason(m: Record<string, unknown>): string | null {
	if (isSet(m.approval_hold)) return 'contact is on approval hold (metadata.approval_hold is set)'
	if (isSet(m.held_reason)) return 'contact is on hold (metadata.held_reason is set)'
	return null
}

// Protect, as the workspace skill sebastian-do-not-contact (rule 4) defines it:
// metadata.protect == true, or metadata.tags containing protect, protected or
// do-not-contact. The personal-do-not-contact and fundraising skills write
// metadata.protected = true, so that is read too. Any one hit refuses.
export const PROTECT_TAGS: readonly string[] = ['protect', 'protected', 'do-not-contact']

function isTrue(v: unknown): boolean {
	return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true')
}

function protectReason(m: Record<string, unknown>): string | null {
	if (isTrue(m.protect)) return 'contact is protected (metadata.protect is set)'
	if (isTrue(m.protected)) return 'contact is protected (metadata.protected is set)'
	const tags = Array.isArray(m.tags) ? m.tags : typeof m.tags === 'string' ? m.tags.split(',') : []
	const hit = tags.find(
		(t) => typeof t === 'string' && PROTECT_TAGS.includes(t.trim().toLowerCase()),
	)
	if (hit) return `contact is protected (metadata.tags contains "${hit.trim()}")`
	return null
}

// ---------------------------------------------------------------------------
// Shared email-hook deny list
// ---------------------------------------------------------------------------

/** Statuses the email-hook deny list refuses. follow_up_later is deliberately NOT here. */
export const EMAIL_HOOK_DENY_STATUSES: readonly string[] = ['deleted_by_request', 'rejected']

export type EmailHookDenyVerdict =
	| { denied: false }
	| { denied: true; check: 'hold' | 'protect' | 'status'; reason: string }

/**
 * THE EMAIL-HOOK DENY LIST. Not the generic suppressing set.
 *
 * Contract: refuses a contact only when it is on hold (metadata.approval_hold or
 * metadata.held_reason), protected (metadata.protect, metadata.protected or a
 * protect tag in metadata.tags), or its status is
 * deleted_by_request or rejected. Nothing else refuses.
 *
 * It must never be reused for the dialer's own check 2. A prospect who asked for
 * the email ends the call on follow_up_later, a suppressing status for the
 * dialer (nobody redials them) but the exact contact the hook has to email. So
 * this function passes follow_up_later and voice_declined. For the same reason a
 * caller should hand it the contact as it was before the hangup reducer ran, or
 * accept that only these four conditions are read.
 *
 * Pure: no I/O, no clock.
 */
export function checkEmailHookDenyList(contact: VoiceContact): EmailHookDenyVerdict {
	const m = meta(contact)
	const hold = holdReason(m)
	if (hold) return { denied: true, check: 'hold', reason: hold }
	const protect = protectReason(m)
	if (protect) return { denied: true, check: 'protect', reason: protect }
	if (EMAIL_HOOK_DENY_STATUSES.includes(contact.status)) {
		return { denied: true, check: 'status', reason: `contact status is ${contact.status}` }
	}
	return { denied: false }
}

// ---------------------------------------------------------------------------
// Dialer gate
// ---------------------------------------------------------------------------

/** The dialer's own check 2 set. Broader than the email-hook deny list on purpose. */
export const DIALER_SUPPRESSING_STATUSES: readonly string[] = [
	'voice_declined',
	'follow_up_later',
	'deleted_by_request',
	'rejected',
]

export const MAX_DIALS_PER_CONTACT = 3

/**
 * The only metadata.company_type values the dialer accepts, exact and lowercase, as the
 * prospect-list work stamps them from the CVR company form. Sole proprietors are the one
 * protected group reachable by phone, so anything else (or nothing) is refused.
 */
export const DIALABLE_COMPANY_TYPES: readonly string[] = ['aps', 'as']

function companyTypeReason(m: Record<string, unknown>): string | null {
	const v = m.company_type
	if (v === undefined || v === null) {
		return 'contact has no company type (metadata.company_type is missing), so it is not known to be an ApS or A/S'
	}
	if (typeof v === 'string' && DIALABLE_COMPANY_TYPES.includes(v)) return null
	if (v === '') {
		return 'contact company type is empty (metadata.company_type is ""), so it is not known to be an ApS or A/S'
	}
	const found = typeof v === 'string' ? v : JSON.stringify(v)
	return `contact company type "${found}" is not ApS or A/S (metadata.company_type must be aps or as)`
}

export type DncCheck =
	| 'hold'
	| 'status'
	| 'protect'
	| 'investor'
	| 'owner'
	| 'company_type'
	| 'phone'
	| 'time_of_day'
	| 'max_dials'
	| 'erased'

export type DncResult =
	| { pass: true }
	| {
			pass: false
			check: DncCheck
			reason: string
	  }

export interface GateContact extends VoiceContact {
	id: string
}

/** Owner slug to human actor id, from env VOICE_FOUNDER_ACTORS. */
export type FounderActors =
	| { ok: true; map: Record<string, string> }
	| { ok: false; reason: string }

const founderActorsSchema = z
	.record(z.string().min(1), z.string().uuid())
	.refine((m) => Object.keys(m).length > 0, 'map is empty')

/** Zod-parse VOICE_FOUNDER_ACTORS once at startup. Missing, empty or invalid fails closed. */
export function parseFounderActors(raw: string | undefined): FounderActors {
	if (raw === undefined || raw.trim() === '') {
		return { ok: false, reason: 'VOICE_FOUNDER_ACTORS is not set' }
	}
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		return { ok: false, reason: 'VOICE_FOUNDER_ACTORS is not valid JSON' }
	}
	const parsed = founderActorsSchema.safeParse(json)
	if (!parsed.success) {
		return {
			ok: false,
			reason: `VOICE_FOUNDER_ACTORS is invalid (${parsed.error.issues[0]?.message ?? 'bad shape'})`,
		}
	}
	const map: Record<string, string> = {}
	for (const [slug, actorId] of Object.entries(parsed.data))
		map[slug.trim().toLowerCase()] = actorId
	return { ok: true, map }
}

/** Normalises to +45XXXXXXXX, or null when the value is not a Danish number. */
export function normalizeDanishNumber(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	let digits = raw.replace(/[\s\-().]/g, '')
	if (digits.startsWith('0045')) digits = `+${digits.slice(2)}`
	else if (/^\d{8}$/.test(digits)) digits = `+45${digits}`
	return /^\+45\d{8}$/.test(digits) ? digits : null
}

/**
 * The one place the erasure marker field is named for reading. The retention sweep writes it
 * (through this constant) and check 7 below reads it; no report, export, list builder, analytics
 * event or agent tool does.
 */
export const ERASURE_MARKER_FIELD = 'erasure_marker'

/** The marker for a dialled number, written the way the dialer normalises it. Null for a non-+45 number. */
export function erasureMarkerFor(raw: unknown, key: Buffer): string | null {
	const e164 = normalizeDanishNumber(raw)
	return e164 ? computeErasureMarker(e164, key) : null
}

export interface ActorRef {
	type: string
}

export interface DncGateDeps {
	now: Date
	founders: FounderActors
	findActor(actorId: string): Promise<ActorRef | null>
	/** Parsed VOICE_ERASURE_MARKER_KEY. Not ok refuses every dial at check 7. */
	erasure: ErasureKey
	/** True when a deleted_by_request contact in the same workspace carries this marker. */
	matchesErasedContact(marker: string): Promise<boolean>
	/**
	 * True when a deleted_by_request contact in the same workspace that the sweep has not reached
	 * yet (no erased_at, so it still holds its number and has no marker) stores this +45 number.
	 */
	matchesUnsweptErasedContact(e164: string): Promise<boolean>
}

const ERASED_CONTACT_REASON = 'matches erased contact'

function refuse(check: DncCheck, reason: string): Extract<DncResult, { pass: false }> {
	return { pass: false, check, reason }
}

export function inDialWindow(now: Date): boolean {
	const p = copenhagenParts(now)
	const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
	if (dow === 0 || dow === 6) return false
	return p.hour >= DIAL_WINDOW_START_HOUR && p.hour < DIAL_WINDOW_END_HOUR
}

/**
 * The seven ordered, fail-closed pre-dial checks, plus the skill-rule mirror
 * (protected contact, role investor) which runs right after the status check
 * because it only reads fields. The first refusal wins.
 */
export async function runDncGate(contact: GateContact, deps: DncGateDeps): Promise<DncResult> {
	const m = meta(contact)

	// 1. Hold.
	const hold = holdReason(m)
	if (hold) return refuse('hold', hold)

	// 2. Suppressing status. Includes follow_up_later: the dialer gate sees the
	// pre-call state, and nobody redials a prospect who asked for an email.
	if (DIALER_SUPPRESSING_STATUSES.includes(contact.status)) {
		return refuse('status', `contact status is ${contact.status}, which suppresses dialing`)
	}

	// Skill-rule mirror.
	const protect = protectReason(m)
	if (protect) return refuse('protect', protect)
	if (m.role === 'investor' || m.lead_source === 'investor_pipeline') {
		return refuse('investor', 'contact is an investor (never contacted by sales motions)')
	}

	// 3. Founder-owned only. metadata.owner is a slug that must map to a live human actor.
	if (!deps.founders.ok)
		return refuse('owner', `founder rule cannot be evaluated: ${deps.founders.reason}`)
	const owner = typeof m.owner === 'string' ? m.owner.trim().toLowerCase() : ''
	if (!owner) return refuse('owner', 'contact has no owner')
	const actorId = Object.hasOwn(deps.founders.map, owner) ? deps.founders.map[owner] : undefined
	if (!actorId) return refuse('owner', `owner "${owner}" is not a founder in VOICE_FOUNDER_ACTORS`)
	let actor: ActorRef | null
	try {
		actor = await deps.findActor(actorId)
	} catch {
		return refuse('owner', `founder actor for "${owner}" could not be looked up`)
	}
	if (!actor) return refuse('owner', `founder actor for "${owner}" no longer exists`)
	if (actor.type !== 'human') return refuse('owner', `founder actor for "${owner}" is not a human`)

	// 4. Company type. Only an ApS or A/S is dialed; sole proprietors are a protected group.
	const companyType = companyTypeReason(m)
	if (companyType) return refuse('company_type', companyType)

	// 4b. Phone. Needs a +45 number it can normalise.
	if (!normalizeDanishNumber(m.phone)) {
		return refuse('phone', 'contact has no valid +45 number to dial')
	}

	// 5. Time of day, Europe/Copenhagen workdays 09:00-16:00.
	if (!inDialWindow(deps.now)) {
		return refuse('time_of_day', 'outside the Europe/Copenhagen 09:00-16:00 workday dial window')
	}

	// 6. Max dials per contact ever. The backstop against any retry loop.
	const dials = typeof m.dial_attempt_n === 'number' ? m.dial_attempt_n : 0
	if (dials >= MAX_DIALS_PER_CONTACT) {
		return refuse(
			'max_dials',
			`contact already dialed ${dials} times (max ${MAX_DIALS_PER_CONTACT})`,
		)
	}

	// 7. Erased contact. A new row for a person who asked to be erased carries the same number
	// as the surviving erased row, which keeps only a keyed hash of it (see erasure-key.ts). The
	// refusal reason is fixed text: neither the marker nor the number is ever put in it.
	// (a) The row's own metadata carries a marker: it is an erased row whose status an import
	// overwrote. Own-row, no query.
	if (isSet(m[ERASURE_MARKER_FIELD])) return refuse('erased', ERASED_CONTACT_REASON)
	// (b) Its number hashes to the marker of a deleted_by_request contact in this workspace.
	// (c) Sweep window: or it equals the stored number of a deleted_by_request contact the sweep
	// has not reached yet, which has no marker. A failed Telnyx or blob delete keeps a row in that
	// state until the next daily retry succeeds. After the sweep the same row is caught by (b).
	if (!deps.erasure.ok) {
		return refuse('erased', `erased-contact check cannot run: ${deps.erasure.reason}`)
	}
	const e164 = normalizeDanishNumber(m.phone)
	const marker = e164 ? computeErasureMarker(e164, deps.erasure.key) : null
	if (!e164 || !marker) return refuse('phone', 'contact has no valid +45 number to dial')
	let matches: boolean
	try {
		matches =
			(await deps.matchesErasedContact(marker)) || (await deps.matchesUnsweptErasedContact(e164))
	} catch {
		return refuse('erased', 'erased-contact check could not be completed')
	}
	if (matches) return refuse('erased', ERASED_CONTACT_REASON)

	return { pass: true }
}
