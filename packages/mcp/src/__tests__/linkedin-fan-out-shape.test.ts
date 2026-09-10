import { afterEach, describe, expect, it } from 'vitest'
import {
	LINKEDIN_ALL_VERBS,
	__resetLinkedInMcpRegistryForTests,
	instanceSlug,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
	toolName,
	toolsForIdentity,
} from '../lib/linkedin-fan-out.js'
import type { LinkedInMcpInstanceConfig } from '../lib/linkedin-fan-out.js'

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
