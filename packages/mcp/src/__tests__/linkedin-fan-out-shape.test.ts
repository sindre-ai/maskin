import { afterEach, describe, expect, it } from 'vitest'
import {
	LINKEDIN_ALL_VERBS,
	LINKEDIN_READ_ONLY_VERBS,
	__resetLinkedInMcpRegistryForTests,
	instanceSlug,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
	toolName,
	toolsForIdentity,
} from '../lib/linkedin-fan-out.js'
import type { LinkedInMcpInstanceConfig, LinkedInVerb } from '../lib/linkedin-fan-out.js'

/**
 * P3-J · Every write verb R11 registers. If a read-only caller sees ANY of
 * these on ANY fanned-out identity, the read-only filter has leaked. Kept
 * inline (rather than derived from `LINKEDIN_ALL_VERBS \ LINKEDIN_READ_ONLY_VERBS`)
 * so a new verb added later has to be classified explicitly — the compiler
 * will tell us which list it belongs on, rather than silently defaulting a
 * new write verb into the read-only surface.
 */
const LINKEDIN_WRITE_VERBS: readonly LinkedInVerb[] = [
	'publish_post',
	'edit_post',
	'delete_post',
	'comment_on_post',
	'reply_to_comment',
	'send_message',
	'reply',
	'send_connection_request',
] as const

/**
 * R11-A · linkedin-mcp-phase2-technical-spec.md §9.2 suite 2 — pin the
 * fan-out shape at the package boundary.
 *
 * The scope here is deliberately narrow: the pure `toolsForIdentity` filter
 * table, the deterministic `instanceSlug`/`toolName` composers, and the
 * in-process registry contract. The end-to-end connect + registry tests
 * live in apps/dev's `__tests__/routes/` — a failure in this file means
 * the R11 primitives themselves have drifted, not that the callback path
 * wired them wrong.
 */

const personal: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	integrationId: 'intg-1',
	unipileAccountId: 'acc-1',
	unipileAccSlug: 'sebastianbille',
	identityType: 'personal',
	identityUrn: 'urn:li:person:seb',
	identitySlug: 'personal',
	displayName: 'Sebastian Bille',
	mailboxId: null,
	messagingEnabled: true,
}

const pageMessagingEnabled: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	integrationId: 'intg-1',
	unipileAccountId: 'acc-1',
	unipileAccSlug: 'sebastianbille',
	identityType: 'company_page',
	identityUrn: 'urn:li:organization:1',
	identitySlug: 'maskinio',
	displayName: 'Maskin',
	mailboxId: 'mailbox-maskinio',
	messagingEnabled: true,
}

const pageMessagingDisabled: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	integrationId: 'intg-1',
	unipileAccountId: 'acc-1',
	unipileAccSlug: 'sebastianbille',
	identityType: 'company_page',
	identityUrn: 'urn:li:organization:2',
	identitySlug: 'sample-page',
	displayName: 'Sample Page',
	mailboxId: null,
	messagingEnabled: false,
}

describe('toolsForIdentity — §2 filter matrix', () => {
	it('personal registers every R11 verb (Phase 1 + Phase 2)', () => {
		expect(toolsForIdentity(personal).sort()).toEqual([...LINKEDIN_ALL_VERBS].sort())
	})

	it('page with messagingEnabled=true registers posts + messaging suites but never personal-only ones', () => {
		const verbs = new Set(toolsForIdentity(pageMessagingEnabled))
		expect(verbs.has('publish_post')).toBe(true)
		expect(verbs.has('read_post_comments')).toBe(true)
		expect(verbs.has('comment_on_post')).toBe(true)
		expect(verbs.has('reply_to_comment')).toBe(true)
		expect(verbs.has('get_post_engagement')).toBe(true)
		expect(verbs.has('send_message')).toBe(true)
		expect(verbs.has('reply')).toBe(true)
		expect(verbs.has('list_conversations')).toBe(true)
		expect(verbs.has('list_messages')).toBe(true)
		// Personal-only suites are never registered on a page, even
		// when messaging is enabled.
		expect(verbs.has('send_connection_request')).toBe(false)
		expect(verbs.has('list_connections')).toBe(false)
		expect(verbs.has('search_people')).toBe(false)
		expect(verbs.has('get_profile')).toBe(false)
	})

	it('page with messagingEnabled=false registers posts suite only', () => {
		const verbs = new Set(toolsForIdentity(pageMessagingDisabled))
		// Posts suite lands.
		expect(verbs.has('publish_post')).toBe(true)
		expect(verbs.has('read_post_comments')).toBe(true)
		expect(verbs.has('comment_on_post')).toBe(true)
		expect(verbs.has('reply_to_comment')).toBe(true)
		expect(verbs.has('get_post_engagement')).toBe(true)
		// Messaging suite is filtered out entirely on a publish-only page.
		expect(verbs.has('send_message')).toBe(false)
		expect(verbs.has('reply')).toBe(false)
		expect(verbs.has('list_conversations')).toBe(false)
		expect(verbs.has('list_messages')).toBe(false)
		// Personal-only suites still filtered out.
		expect(verbs.has('send_connection_request')).toBe(false)
		expect(verbs.has('list_connections')).toBe(false)
		expect(verbs.has('search_people')).toBe(false)
		expect(verbs.has('get_profile')).toBe(false)
	})

	it('preserves canonical order (spec order, not alphabetical) — stable tools/list diffs', () => {
		// `LINKEDIN_ALL_VERBS` (Phase 1 + Phase 2 R11-B verbs) is the canonical
		// order. For personal, the filter output must be exactly that order.
		expect(toolsForIdentity(personal)).toEqual([...LINKEDIN_ALL_VERBS])
	})
})

describe('toolsForIdentity — P3-J read-only caller filter (gap-17)', () => {
	it('personal + readOnly narrows to the read-only allowlist exactly', () => {
		// A read-only-tagged caller sees only network-reading verbs the
		// [Investor Relations] warm-intro path needs — never any write verb
		// and never any messaging / posts / engagement verb either. The
		// allowlist IS the surface, not a maximum.
		expect(toolsForIdentity(personal, { readOnly: true })).toEqual([...LINKEDIN_READ_ONLY_VERBS])
	})

	it('personal without readOnly is unchanged (non-read-only callers get the full surface)', () => {
		// Rail 3 for this file: the flag only ever REMOVES verbs. A missing
		// or false opt must yield exactly the identity-side output, byte for
		// byte — the acceptance criterion "non-read-only caller sees the full
		// existing surface unchanged" comes down to this equality.
		expect(toolsForIdentity(personal)).toEqual(toolsForIdentity(personal, { readOnly: false }))
		expect(toolsForIdentity(personal)).toEqual([...LINKEDIN_ALL_VERBS])
	})

	it('page + readOnly = empty surface — the allowlist is personal-only in §2', () => {
		// All three read-only verbs live in the profile / connections suites
		// which the §2 table restricts to `identityType: 'personal'`. On a
		// company_page instance (messaging-enabled OR publish-only) the
		// intersection is empty by construction — a read-only agent attached
		// to a page identity carries no tools.
		expect(toolsForIdentity(pageMessagingEnabled, { readOnly: true })).toEqual([])
		expect(toolsForIdentity(pageMessagingDisabled, { readOnly: true })).toEqual([])
	})

	it('no write verb ever appears in a read-only surface — across every identity shape', () => {
		// The load-bearing gap-17 assertion, run against the three concrete
		// identity shapes the fan-out actually produces (personal + messaging-
		// enabled page + publish-only page). If ANY of the 8 write verbs
		// leaks through the filter on ANY of these, IR's warm-intro loadout
		// is unsafe to attach — which is exactly the bug this task closes.
		const writeVerbs = new Set<LinkedInVerb>(LINKEDIN_WRITE_VERBS)
		for (const cfg of [personal, pageMessagingEnabled, pageMessagingDisabled]) {
			const surface = toolsForIdentity(cfg, { readOnly: true })
			for (const v of surface) {
				expect(writeVerbs.has(v)).toBe(false)
			}
		}
	})

	it('the read-only allowlist itself carries no write verb', () => {
		// Guards against a future edit of `LINKEDIN_READ_ONLY_VERBS` — if
		// anyone adds `publish_post` (or any of the 8 write verbs) to the
		// allowlist, the filter is silently defeated on personal instances.
		// Keep this check on the CONST, not on filtered output, so the
		// intent is visible at the site of the change.
		const writeVerbs = new Set<LinkedInVerb>(LINKEDIN_WRITE_VERBS)
		for (const v of LINKEDIN_READ_ONLY_VERBS) {
			expect(writeVerbs.has(v)).toBe(false)
		}
	})

	it('preserves canonical order for the personal read-only surface', () => {
		// Same diff-stability rule as the identity-side filter: the read-only
		// output must land in `LINKEDIN_ALL_VERBS` order so a `tools/list`
		// diff on a read-only agent stays stable across restarts.
		const surface = toolsForIdentity(personal, { readOnly: true })
		const canonicalOrder = LINKEDIN_ALL_VERBS.filter((v) =>
			(LINKEDIN_READ_ONLY_VERBS as readonly LinkedInVerb[]).includes(v),
		)
		expect(surface).toEqual(canonicalOrder)
	})
})

describe('instance slug + tool name composers — deterministic naming', () => {
	it('slug format is linkedin-{unipileAccSlug}-{identitySlug}', () => {
		expect(instanceSlug(personal)).toBe('linkedin-sebastianbille-personal')
		expect(instanceSlug(pageMessagingEnabled)).toBe('linkedin-sebastianbille-maskinio')
	})

	it('tool name doubles the underscore between instance slug and verb', () => {
		// The double-underscore is what separates the retired flat namespace
		// (`linkedin_send_message`) from the fan-out namespace
		// (`linkedin-{acc}-{identity}__send_message`) unambiguously.
		expect(toolName(personal, 'send_message')).toBe(
			'linkedin-sebastianbille-personal__send_message',
		)
		expect(toolName(pageMessagingEnabled, 'publish_post')).toBe(
			'linkedin-sebastianbille-maskinio__publish_post',
		)
	})

	it('is deterministic across two calls of the same cfg (idempotent reconnect)', () => {
		// The registry contract says re-registering the same
		// `(unipile_acc_slug, identity_slug)` replaces the prior instance
		// atomically. The naming must be identical between the two calls or
		// downstream diffs won't show them as the same instance.
		expect(instanceSlug(personal)).toBe(instanceSlug({ ...personal }))
		expect(toolName(personal, 'publish_post')).toBe(toolName({ ...personal }, 'publish_post'))
	})
})

describe('registry — R11-A idempotency + retired flat namespace', () => {
	afterEach(() => __resetLinkedInMcpRegistryForTests())

	it('registerLinkedInMcpInstance is idempotent per (integrationId, identitySlug)', () => {
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(personal)
		// Second call replaced, did not append.
		expect(listLinkedInMcpInstances().size).toBe(1)
		expect(listLinkedInMcpInstances().get('linkedin-sebastianbille-personal')).toEqual(personal)
	})

	it('registers personal + N pages independently', () => {
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(pageMessagingEnabled)
		registerLinkedInMcpInstance(pageMessagingDisabled)
		const flat = listLinkedInMcpInstances()
		expect([...flat.keys()].sort()).toEqual([
			'linkedin-sebastianbille-maskinio',
			'linkedin-sebastianbille-personal',
			'linkedin-sebastianbille-sample-page',
		])
	})

	it('the retired flat linkedin__ namespace never appears in registry names', () => {
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(pageMessagingEnabled)
		registerLinkedInMcpInstance(pageMessagingDisabled)
		for (const slug of listLinkedInMcpInstances().keys()) {
			// Every instance name has the fan-out structure — no legacy
			// `linkedin__` (or bare `linkedin_send_message`-style) survivors.
			expect(slug.startsWith('linkedin-')).toBe(true)
			expect(slug).not.toMatch(/^linkedin__/)
			expect(slug).not.toMatch(/^linkedin_[a-z]/)
		}
	})

	it('a page revocation deregisters cleanly and leaves personal alone', () => {
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(pageMessagingEnabled)
		expect(listLinkedInMcpInstances().size).toBe(2)
		__resetLinkedInMcpRegistryForTests()
		registerLinkedInMcpInstance(personal)
		// A revocation flow (R11-C) that drops the page but keeps personal
		// results in the registry holding only the surviving identity.
		expect([...listLinkedInMcpInstances().keys()]).toEqual(['linkedin-sebastianbille-personal'])
	})
})
