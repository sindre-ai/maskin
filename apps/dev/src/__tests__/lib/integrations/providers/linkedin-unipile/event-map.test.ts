import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { config } from '../../../../../lib/integrations/providers/linkedin-unipile/config'
import { readUnipileEnvelope } from '../../../../../lib/integrations/providers/linkedin-unipile/envelope'
import {
	EVENT_MAP,
	getEventMapRow,
} from '../../../../../lib/integrations/providers/linkedin-unipile/event-map'

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__',
)

function loadFixture(type: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDir, `${type}.json`), 'utf8'))
}

describe('EVENT_MAP table', () => {
	it('has the message.new and relation.new rows', () => {
		expect(Object.keys(EVENT_MAP)).toContain('message.new')
		expect(Object.keys(EVENT_MAP)).toContain('relation.new')
	})

	describe.each(Object.entries(EVENT_MAP))('row %s', (type, row) => {
		it('has a fixture in the real envelope shape', () => {
			const fixture = loadFixture(type) as Record<string, unknown>
			for (const key of ['id', 'created_at', 'account_id', 'type', 'payload']) {
				expect(fixture).toHaveProperty(key)
			}
			expect(fixture.type).toBe(type)
		})

		it('returns a deliveryKey (not null) on its fixture', () => {
			const envelope = readUnipileEnvelope(loadFixture(type))
			expect(row.deliveryKey(envelope)).not.toBeNull()
		})

		it('reads the account id from its fixture', () => {
			const envelope = readUnipileEnvelope(loadFixture(type))
			expect(row.accountId(envelope)).toBe((loadFixture(type) as { account_id: string }).account_id)
		})

		it('has its entityType and every action in config events.definitions', () => {
			const definition = config.events?.definitions.find((d) => d.entityType === row.entityType)
			expect(definition, `${row.entityType} missing from config definitions`).toBeDefined()
			for (const action of row.actions) {
				expect(definition?.actions).toContain(action)
			}
			expect(definition?.label).toBeTruthy()
		})
	})
})

describe('message.new actions', () => {
	it('lists received, received_cold and received_unresolved in the map and in config definitions', () => {
		const expected = ['received', 'received_cold', 'received_unresolved']
		expect([...(getEventMapRow('message.new')?.actions ?? [])].sort()).toEqual(expected)
		const definition = config.events?.definitions.find((d) => d.entityType === 'linkedin.message')
		expect([...(definition?.actions ?? [])].sort()).toEqual(expected)
	})
})

describe('message.new deliveryKey', () => {
	it('is msg:[account_id]:[payload.id]', () => {
		const row = getEventMapRow('message.new')
		const envelope = readUnipileEnvelope(loadFixture('message.new'))
		expect(row?.deliveryKey(envelope)).toBe(
			`msg:${envelope.accountId}:${(envelope.resource as { id: string }).id}`,
		)
	})

	it('is null when the message has no id', () => {
		const row = getEventMapRow('message.new')
		expect(
			row?.deliveryKey(readUnipileEnvelope({ type: 'message.new', account_id: 'a', payload: {} })),
		).toBeNull()
	})
})

describe('relation.new actions', () => {
	it('lists accepted and new in the map and in config definitions', () => {
		const expected = ['accepted', 'new']
		const row = getEventMapRow('relation.new')
		expect(row?.entityType).toBe('linkedin.connection')
		expect([...(row?.actions ?? [])].sort()).toEqual(expected)
		const definition = config.events?.definitions.find(
			(d) => d.entityType === 'linkedin.connection',
		)
		expect([...(definition?.actions ?? [])].sort()).toEqual(expected)
	})
})

describe('relation.new deliveryKey', () => {
	it('is rel:[account_id]:[the other person provider id]', () => {
		const row = getEventMapRow('relation.new')
		const envelope = readUnipileEnvelope(loadFixture('relation.new'))
		expect(row?.deliveryKey(envelope)).toBe(
			`rel:${envelope.accountId}:${(envelope.resource as { id: string }).id}`,
		)
	})

	it('is null when the relation has no id', () => {
		const row = getEventMapRow('relation.new')
		expect(
			row?.deliveryKey(readUnipileEnvelope({ type: 'relation.new', account_id: 'a', payload: {} })),
		).toBeNull()
	})

	it('is null when the envelope has no account id', () => {
		const row = getEventMapRow('relation.new')
		expect(
			row?.deliveryKey(readUnipileEnvelope({ type: 'relation.new', payload: { id: 'ACoAAx' } })),
		).toBeNull()
	})
})

describe('relation.new fixture', () => {
	it('carries id and public_identifier in the payload', () => {
		const envelope = readUnipileEnvelope(loadFixture('relation.new'))
		expect(envelope.resource).toMatchObject({
			id: expect.any(String),
			public_identifier: expect.any(String),
		})
	})
})

describe('getEventMapRow', () => {
	it('returns null for unknown types and prototype members', () => {
		expect(getEventMapRow('chat.new')).toBeNull()
		expect(getEventMapRow('constructor')).toBeNull()
		expect(getEventMapRow('toString')).toBeNull()
		expect(getEventMapRow(null)).toBeNull()
	})
})

describe('linkedin-unipile config', () => {
	it('carries events.definitions with no mapping key and no webhook key', () => {
		expect(config.events?.definitions.length).toBeGreaterThan(0)
		expect(config.events).not.toHaveProperty('mapping')
		expect(config).not.toHaveProperty('webhook')
	})
})

describe('account event rows', () => {
	const ACCOUNT_TYPES = [
		'account.reconnect',
		'account.status.disconnected',
		'account.status.errored',
		'account.status.degraded',
		'account.status.locked',
		'account.status.running',
	]

	it.each(ACCOUNT_TYPES)('%s is linkedin.account status_changed', (type) => {
		const row = getEventMapRow(type)
		expect(row?.entityType).toBe('linkedin.account')
		expect(row?.actions).toEqual(['status_changed'])
	})

	it('lists status_changed for linkedin.account in config definitions', () => {
		const definition = config.events?.definitions.find((d) => d.entityType === 'linkedin.account')
		expect(definition?.actions).toEqual(['status_changed'])
	})

	it.each(ACCOUNT_TYPES)('%s deliveryKey is acct:[type]:[account_id]:[created_at]', (type) => {
		const fixture = loadFixture(type) as { account_id: string; created_at: string }
		const envelope = readUnipileEnvelope(fixture)
		expect(getEventMapRow(type)?.deliveryKey(envelope)).toBe(
			`acct:${type}:${fixture.account_id}:${fixture.created_at}`,
		)
	})

	it('has no content key without created_at, so only the envelope claim applies', () => {
		const envelope = readUnipileEnvelope({ type: 'account.status.running', account_id: 'a' })
		expect(getEventMapRow('account.status.running')?.deliveryKey(envelope)).toBeNull()
	})

	it('reads top-level type, account_id and created_at with no nested fallback', () => {
		const envelope = readUnipileEnvelope({
			type: 'account.status.locked',
			account_id: 'top',
			created_at: '2026-10-04T11:00:00.000Z',
			payload: { account_id: 'nested', created_at: 'nested' },
		})
		expect(envelope.accountId).toBe('top')
		expect(envelope.createdAt).toBe('2026-10-04T11:00:00.000Z')
		expect(
			readUnipileEnvelope({ type: 'account.status.locked', payload: { account_id: 'nested' } })
				.accountId,
		).toBeNull()
	})
})
