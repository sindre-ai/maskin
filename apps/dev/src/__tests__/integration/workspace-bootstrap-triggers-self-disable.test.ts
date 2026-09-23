import { triggers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { db, sql as rawSql } from './global-setup'

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ONE_SHOT_TRIGGER_NAMES = [
	'First-pass brief filed → present for confirmation',
	'First-pass brief validated → deep research',
] as const

async function bootstrapFreshWorkspace(email: string, apiKey: string) {
	const [ownerRow] = await rawSql`
		INSERT INTO actors (type, name, email, api_key)
		VALUES ('human', 'Bootstrap Owner', ${email}, ${apiKey})
		RETURNING id
	`
	const ownerId = ownerRow.id as string
	const ws = await insertWorkspace(db, ownerId)
	if (!ws) throw new Error('workspace insert returned no row')
	const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
	await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)
	return ws.id
}

async function getOneShotTriggers(workspaceId: string) {
	const rows = await db
		.select({
			id: triggers.id,
			name: triggers.name,
			actionPrompt: triggers.actionPrompt,
		})
		.from(triggers)
		.where(eq(triggers.workspaceId, workspaceId))
	return rows.filter((r) => (ONE_SHOT_TRIGGER_NAMES as readonly string[]).includes(r.name))
}

describe('bootstrapDefaultAgents — onboarding-only Chief of Staff trigger self-disable', () => {
	beforeEach(async () => {
		await rawSql`TRUNCATE actors CASCADE`
	})

	it("interpolates each trigger's own id as a literal UUID into its actionPrompt with an update_trigger self-disable instruction", async () => {
		const workspaceId = await bootstrapFreshWorkspace(
			'bootstrap-triggers-1@test.com',
			'ank_testtriggers1',
		)

		const oneShotTriggers = await getOneShotTriggers(workspaceId)
		expect(oneShotTriggers).toHaveLength(2)

		for (const trigger of oneShotTriggers) {
			expect(trigger.id).toMatch(UUID_RE)
			expect(trigger.actionPrompt.includes('{{trigger_id}}')).toBe(false)
			expect(trigger.actionPrompt.includes(trigger.id)).toBe(true)
			expect(trigger.actionPrompt).toMatch(
				new RegExp(`update_trigger[\\s\\S]*id:\\s*${trigger.id}[\\s\\S]*enabled:\\s*false`, 'i'),
			)
		}
	})

	it('produces distinct, per-workspace trigger ids for each bootstrap — the ids are not a shared constant baked into the seed file', async () => {
		const wsA = await bootstrapFreshWorkspace('bootstrap-triggers-a@test.com', 'ank_testtriggersa')
		const wsB = await bootstrapFreshWorkspace('bootstrap-triggers-b@test.com', 'ank_testtriggersb')

		const aTriggers = await getOneShotTriggers(wsA)
		const bTriggers = await getOneShotTriggers(wsB)

		expect(aTriggers).toHaveLength(2)
		expect(bTriggers).toHaveLength(2)

		for (const name of ONE_SHOT_TRIGGER_NAMES) {
			const a = aTriggers.find((r) => r.name === name)
			const b = bTriggers.find((r) => r.name === name)
			if (!a || !b) throw new Error(`missing trigger "${name}" in one of the bootstraps`)
			expect(a.id).not.toBe(b.id)
			expect(a.actionPrompt.includes(a.id)).toBe(true)
			expect(a.actionPrompt.includes(b.id)).toBe(false)
			expect(b.actionPrompt.includes(b.id)).toBe(true)
			expect(b.actionPrompt.includes(a.id)).toBe(false)
		}
	})

	it('leaves triggers without the {{trigger_id}} placeholder unchanged (only the two onboarding triggers use pre-generated ids)', async () => {
		const workspaceId = await bootstrapFreshWorkspace(
			'bootstrap-triggers-3@test.com',
			'ank_testtriggers3',
		)

		const otherRows = await db
			.select({
				id: triggers.id,
				name: triggers.name,
				actionPrompt: triggers.actionPrompt,
			})
			.from(triggers)
			.where(eq(triggers.workspaceId, workspaceId))

		const nonOneShot = otherRows.filter(
			(r) => !(ONE_SHOT_TRIGGER_NAMES as readonly string[]).includes(r.name),
		)
		expect(nonOneShot.length).toBeGreaterThan(0)
		for (const trigger of nonOneShot) {
			expect(trigger.actionPrompt.includes('{{trigger_id}}')).toBe(false)
			expect(trigger.actionPrompt.includes(trigger.id)).toBe(false)
		}
	})
})
