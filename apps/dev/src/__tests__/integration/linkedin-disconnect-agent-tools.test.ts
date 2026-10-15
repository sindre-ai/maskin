import {
	INTEGRATION_STATUS_ACTIVE,
	type IntegrationStatus,
	actors,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	__resetLinkedInMcpRegistryForTests,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

/**
 * Disconnecting one LinkedIn identity must strip only that identity's MCP
 * entry from agents' own tools config. Before this, the cleanup matched on the
 * provider path alone, so disconnecting the revoked Magnus connection also
 * removed the live `linkedin-krumhausen-personal` entry from 8 agents.
 *
 * Real Postgres and the real DELETE route: the matcher reads sibling
 * credentials from `integrations`, and the strip is a jsonb round-trip on
 * `actors.tools`.
 */

const MCP_BASE = '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp'

function identityEntry(slug: string) {
	return {
		type: 'http',
		url: `${MCP_BASE}/${slug}`,
		headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
	}
}

const MASKIN_ENTRY = {
	type: 'http',
	url: '${MASKIN_API_URL}/mcp',
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}

let deleteRoute: ReturnType<typeof createIntegrationApp>

beforeAll(async () => {
	const { default: integrationsRoutes } = await import('../../routes/integrations')
	deleteRoute = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
})

beforeEach(() => {
	__resetLinkedInMcpRegistryForTests()
})

async function insertLinkedIn(
	workspaceId: string,
	accountId: string,
	unipileAccSlug: string | null,
	status: IntegrationStatus = INTEGRATION_STATUS_ACTIVE,
) {
	const ownerId = getTestActorId()
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status,
			externalId: accountId,
			credentials: encrypt(JSON.stringify({ account_id: accountId, account_status: 'OK' })),
			unipileAccSlug,
			createdBy: ownerId,
		})
		.returning()
	return row
}

function register(
	row: { id: string; workspaceId: string },
	unipileAccSlug: string,
	identitySlug: string,
) {
	const cfg: LinkedInMcpInstanceConfig = {
		workspaceId: row.workspaceId,
		actorId: getTestActorId(),
		integrationId: row.id,
		unipileAccountId: `acc-${unipileAccSlug}`,
		unipileAccSlug,
		identityType: identitySlug === 'personal' ? 'personal' : 'company_page',
		identityUrn: `urn:li:person:${unipileAccSlug}`,
		identitySlug,
		displayName: unipileAccSlug,
		mailboxId: null,
		messagingEnabled: true,
	}
	registerLinkedInMcpInstance(cfg)
}

async function insertAgent(workspaceId: string, mcpServers: Record<string, unknown>) {
	const [agent] = await db
		.insert(actors)
		.values({
			type: 'agent',
			name: 'Sales Rep',
			apiKey: `ank_${crypto.randomUUID()}`,
			tools: { mcpServers },
		})
		.returning()
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

async function serverKeys(actorId: string): Promise<string[]> {
	const [row] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	const tools = (row?.tools ?? {}) as { mcpServers?: Record<string, unknown> }
	return Object.keys(tools.mcpServers ?? {}).sort()
}

async function disconnect(workspaceId: string, integrationId: string) {
	const res = await deleteRoute.request(
		new Request(`http://localhost/api/integrations/${integrationId}`, {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': workspaceId },
		}),
	)
	expect(res.status).toBe(200)
}

describe('DELETE /api/integrations/:id for linkedin-unipile', () => {
	it('removes only the disconnected identity entry and keeps the other identity', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const magnus = await insertLinkedIn(ws.id, 'acc-m', 'magnus')
		const sebastian = await insertLinkedIn(ws.id, 'acc-k', 'krumhausen')
		register(magnus, 'magnus', 'personal')
		register(magnus, 'magnus', 'acme-page')
		register(sebastian, 'krumhausen', 'personal')
		const agent = await insertAgent(ws.id, {
			maskin: MASKIN_ENTRY,
			'linkedin-magnus-personal': identityEntry('linkedin-magnus-personal'),
			'linkedin-magnus-acme-page': identityEntry('linkedin-magnus-acme-page'),
			'linkedin-krumhausen-personal': identityEntry('linkedin-krumhausen-personal'),
		})

		await disconnect(ws.id, magnus.id)

		expect(await serverKeys(agent.id)).toEqual(['linkedin-krumhausen-personal', 'maskin'])
	})

	// The incident shape: the revoked connection had no registry entries left
	// (upstream revoke / restart), so only the persisted account slug says
	// which entries were its own.
	it('still removes the entries of a credential that is no longer in the registry', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const magnus = await insertLinkedIn(ws.id, 'acc-m', 'magnus', 'revoked')
		await insertLinkedIn(ws.id, 'acc-k', 'krumhausen')
		const agent = await insertAgent(ws.id, {
			'linkedin-magnus-personal': identityEntry('linkedin-magnus-personal'),
			'linkedin-krumhausen-personal': identityEntry('linkedin-krumhausen-personal'),
		})

		await disconnect(ws.id, magnus.id)

		expect(await serverKeys(agent.id)).toEqual(['linkedin-krumhausen-personal'])
	})

	it('matches the endpoint URL, not the key, so a renamed entry is still removed', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const magnus = await insertLinkedIn(ws.id, 'acc-m', 'magnus')
		register(magnus, 'magnus', 'personal')
		const agent = await insertAgent(ws.id, {
			'my-linkedin': identityEntry('linkedin-magnus-personal'),
			'linkedin-magnus-personal': identityEntry('linkedin-krumhausen-personal'),
		})

		await disconnect(ws.id, magnus.id)

		expect(await serverKeys(agent.id)).toEqual(['linkedin-magnus-personal'])
	})

	// Account slugs contain hyphens: "jo" must not claim "linkedin-jo-smith-personal".
	it('does not claim a longer account slug that shares its prefix', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const jo = await insertLinkedIn(ws.id, 'acc-jo', 'jo')
		await insertLinkedIn(ws.id, 'acc-js', 'jo-smith')
		const agent = await insertAgent(ws.id, {
			'linkedin-jo-personal': identityEntry('linkedin-jo-personal'),
			'linkedin-jo-smith-personal': identityEntry('linkedin-jo-smith-personal'),
		})

		await disconnect(ws.id, jo.id)

		expect(await serverKeys(agent.id)).toEqual(['linkedin-jo-smith-personal'])
	})

	it('keeps entries another live credential on the same account still serves', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const old = await insertLinkedIn(ws.id, 'acc-old', 'magnus')
		await insertLinkedIn(ws.id, 'acc-new', 'magnus')
		const agent = await insertAgent(ws.id, {
			'linkedin-magnus-personal': identityEntry('linkedin-magnus-personal'),
		})

		await disconnect(ws.id, old.id)

		expect(await serverKeys(agent.id)).toEqual(['linkedin-magnus-personal'])
	})

	it('leaves the deprecated aggregate entry and a hand-written server alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const magnus = await insertLinkedIn(ws.id, 'acc-m', 'magnus')
		register(magnus, 'magnus', 'personal')
		const agent = await insertAgent(ws.id, {
			'linkedin-unipile': { type: 'http', url: MCP_BASE },
			'linkedin-magnus-personal': { type: 'http', url: 'https://example.com/my-own/mcp' },
		})

		await disconnect(ws.id, magnus.id)

		expect(await serverKeys(agent.id)).toEqual([
			'linkedin-magnus-personal',
			'linkedin-unipile',
		])
	})
})
