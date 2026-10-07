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
	it('has at least the message.new row', () => {
		expect(Object.keys(EVENT_MAP)).toContain('message.new')
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

describe('getEventMapRow', () => {
	it('returns null for unknown types and prototype members', () => {
		expect(getEventMapRow('relation.new')).toBeNull()
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
