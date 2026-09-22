import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { LINKEDIN_READ_ONLY_VERBS, toolName } from '@maskin/mcp/linkedin'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import {
	createLinkedInMcpServer,
	registerLinkedInMcpInstance,
} from '../../../../../lib/integrations/providers/linkedin-unipile/mcp-server'

/**
 * P3-J · Contract test at the fan-out layer for gap-17 (read-only agents
 * cannot safely attach fan-out — write verbs leak). The pure filter table
 * lives in packages/mcp's `linkedin-fan-out-shape.test.ts`; this file pins
 * the SAME rule at the layer that actually calls `server.registerTool` — the
 * `registerLinkedInMcpInstance` in apps/dev's mcp-server. If the two ever
 * diverge (someone bypasses `toolsForIdentity(cfg, {readOnly})` in one and
 * not the other), THIS test flips red first because it inspects the concrete
 * tool names that reach the MCP server, not the intermediate verb list.
 *
 * Fixture: one personal identity + one admined company page (messaging-
 * enabled), same shape the acceptance criteria name. The two identity
 * shapes together cover the §2 filter table's rules (posts every identity,
 * messaging + connections + profile personal-only), so a read-only leak on
 * either shape fails the assertion.
 */

const personal: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'sebastian',
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

const page: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'sebastian',
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

// The 8 write verbs in fan-out slug form for each of the fixture identities.
// The named IR-block list from the P3-J acceptance criterion goes first, then
// the additional write verbs (comment_on_post, reply_to_comment, reply) — a
// caller with these registered can still mutate LinkedIn state.
const WRITE_VERB_TOOL_NAMES = [
	...['publish_post', 'send_message', 'send_connection_request', 'edit_post', 'delete_post'],
	...['comment_on_post', 'reply_to_comment', 'reply'],
] as const

const NULL_DB = {} as Database

function toolNamesOnServer(instances: LinkedInMcpInstanceConfig[], readOnly: boolean): string[] {
	const server = createLinkedInMcpServer(
		{ db: NULL_DB, actorId: 'ir-agent', workspaceId: 'ws-1', readOnly },
		instances,
	)
	const registered = (
		server as unknown as {
			_registeredTools: Record<string, unknown>
		}
	)._registeredTools
	return Object.keys(registered ?? {})
}

describe('registerLinkedInMcpInstance — P3-J read-only fan-out filter (gap-17)', () => {
	it('non-read-only caller sees the full existing surface unchanged (both identities)', () => {
		// Rail 3 for the fan-out layer: the flag only ever REMOVES verbs.
		// A caller without the read-only tag has to see identical tool
		// registrations to what the fan-out produced before this task.
		const names = toolNamesOnServer([personal, page], false)

		// Personal registers every R11 verb (Phase 1 + Phase 2) — including
		// the write ones — under its own instance slug.
		for (const verbName of WRITE_VERB_TOOL_NAMES) {
			expect(names).toContain(toolName(personal, verbName))
		}
		// Page registers the posts + messaging suites when messagingEnabled;
		// personal-only verbs (connections, profile) do not appear on a page.
		expect(names).toContain(toolName(page, 'publish_post'))
		expect(names).toContain(toolName(page, 'edit_post'))
		expect(names).toContain(toolName(page, 'delete_post'))
		expect(names).toContain(toolName(page, 'comment_on_post'))
		expect(names).toContain(toolName(page, 'reply_to_comment'))
		expect(names).toContain(toolName(page, 'send_message'))
		expect(names).toContain(toolName(page, 'reply'))
		// The personal-only suites never appear on a page even with the full
		// surface — same identity-side rule the shape test already pins.
		expect(names).not.toContain(toolName(page, 'send_connection_request'))
		expect(names).not.toContain(toolName(page, 'list_connections'))
		expect(names).not.toContain(toolName(page, 'search_people'))
		expect(names).not.toContain(toolName(page, 'get_profile'))
	})

	it('read-only caller sees ONLY list_connections / search_people / get_profile per identity', () => {
		const names = toolNamesOnServer([personal, page], true)

		// Personal registers the three read-only verbs, in canonical order,
		// under its own instance slug — matches the P3-J acceptance criterion
		// verbatim.
		for (const verb of LINKEDIN_READ_ONLY_VERBS) {
			expect(names).toContain(toolName(personal, verb))
		}
		// Every write verb the acceptance criterion names as filter-out is
		// physically absent from the registered tool set on the read-only
		// caller. Include the two Phase-2 destructive verbs too — the
		// acceptance criterion lists them explicitly.
		for (const verbName of WRITE_VERB_TOOL_NAMES) {
			expect(names).not.toContain(toolName(personal, verbName))
		}
		// The page identity, per the §2 filter, has none of the read-only
		// allowlist verbs (they're personal-only) — so it contributes an
		// empty surface, and in particular NO write verb from it either.
		for (const verbName of WRITE_VERB_TOOL_NAMES) {
			expect(names).not.toContain(toolName(page, verbName))
		}
		// Belt-and-braces on the personal side: no page verbs either (a
		// read-only page-scoped write leak would be visible here).
		expect(names).not.toContain(toolName(page, 'publish_post'))
		expect(names).not.toContain(toolName(page, 'read_post_comments'))
		expect(names).not.toContain(toolName(page, 'get_post_engagement'))
		expect(names).not.toContain(toolName(page, 'list_conversations'))
		expect(names).not.toContain(toolName(page, 'list_messages'))
	})

	it('read-only surface across both identities contains ZERO write verbs — end to end', () => {
		// The load-bearing gap-17 assertion the acceptance criterion cares
		// about: run the fan-out against the two fixture identities as a
		// single MCP server (the shape the /mcp route builds per request),
		// then walk every registered tool name and prove none of the 8 write
		// verbs appears under EITHER identity's slug. If this ever fails, an
		// IR loadout that attaches these instances can mutate LinkedIn.
		const names = toolNamesOnServer([personal, page], true)
		for (const cfg of [personal, page]) {
			for (const verbName of WRITE_VERB_TOOL_NAMES) {
				expect(names).not.toContain(toolName(cfg, verbName))
			}
		}
	})
})

describe('registerLinkedInMcpInstance — respects ctx.readOnly directly', () => {
	// Guard against a future refactor that adds a second registration path in
	// this file (e.g. a "system-agent" branch that skips the filter). Pinning
	// on `registerLinkedInMcpInstance` catches a divergence between that path
	// and `createLinkedInMcpServer` — the two ways this filter can be
	// bypassed.
	it('exposes zero write verbs when called directly with a readOnly context', () => {
		const server = new McpServer({ name: 'test', version: '0.0.0' })
		registerLinkedInMcpInstance(server, personal, {
			db: NULL_DB,
			actorId: 'ir-agent',
			workspaceId: 'ws-1',
			readOnly: true,
		})
		const names = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {},
		)
		for (const verbName of WRITE_VERB_TOOL_NAMES) {
			expect(names).not.toContain(toolName(personal, verbName))
		}
		for (const verb of LINKEDIN_READ_ONLY_VERBS) {
			expect(names).toContain(toolName(personal, verb))
		}
	})
})
