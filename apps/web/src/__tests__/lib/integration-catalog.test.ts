import { accessChipLabel } from '@/components/integrations/agent-access'
import { categoryFor, logoDomainFor } from '@/lib/integration-catalog'
import { describe, expect, it } from 'vitest'

describe('categoryFor', () => {
	it('files known providers under their chip', () => {
		expect(categoryFor('gmail')).toBe('Email & calendar')
		expect(categoryFor('github')).toBe('Code')
		expect(categoryFor('custom-mcp')).toBe('Custom')
		expect(categoryFor('notion')).toBe('Docs & data')
		expect(categoryFor('stripe')).toBe('Sales & payments')
		expect(categoryFor('attio')).toBe('Sales & payments')
	})

	it('lists a provider the catalog does not know under Docs & data', () => {
		expect(categoryFor('brand-new-provider')).toBe('Docs & data')
	})
})

describe('logoDomainFor', () => {
	it('returns the site whose icon draws the logo, or nothing', () => {
		expect(logoDomainFor('slack')).toBe('slack.com')
		expect(logoDomainFor('notion')).toBe('notion.so')
		expect(logoDomainFor('stripe')).toBe('stripe.com')
		expect(logoDomainFor('skjald')).toBeUndefined()
	})
})

describe('accessChipLabel', () => {
	it('names the default level', () => {
		expect(accessChipLabel('read', [])).toBe('Read')
		expect(accessChipLabel('read_write', [])).toBe('Read & write')
	})

	it('counts the agents that differ from the default', () => {
		expect(accessChipLabel('read', [{ access: 'read_write' }])).toBe('Read · 1 exception')
		expect(accessChipLabel('read', [{ access: 'none' }, { access: 'read_write' }])).toBe(
			'Read · 2 exceptions',
		)
	})
})
