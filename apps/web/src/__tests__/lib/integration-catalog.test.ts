import { accessChipLabel } from '@/components/integrations/agent-access'
import {
	addedOnFor,
	categoryFor,
	descriptionFor,
	isNewProvider,
	logoDomainFor,
	newProviders,
	popularProviders,
	vendorFor,
} from '@/lib/integration-catalog'
import { describe, expect, it } from 'vitest'

describe('categoryFor', () => {
	it('files known providers under their chip', () => {
		expect(categoryFor('gmail')).toBe('Email & calendar')
		expect(categoryFor('github')).toBe('Code')
		expect(categoryFor('custom-mcp')).toBe('Custom')
		expect(categoryFor('notion')).toBe('Docs & data')
		expect(categoryFor('stripe')).toBe('Sales & payments')
		expect(categoryFor('attio')).toBe('Sales & payments')
		expect(categoryFor('numina')).toBe('Accounting')
		expect(categoryFor('dinero')).toBe('Accounting')
		expect(categoryFor('uniconta')).toBe('Accounting')
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

describe('vendorFor', () => {
	it('names Google and Microsoft tools and nothing else', () => {
		expect(vendorFor('gmail')).toBe('Google')
		expect(vendorFor('google-search-console')).toBe('Google')
		expect(vendorFor('microsoft')).toBe('Microsoft')
		expect(vendorFor('power-bi')).toBe('Microsoft')
		expect(vendorFor('slack')).toBeUndefined()
		expect(vendorFor('brand-new-provider')).toBeUndefined()
	})
})

describe('descriptionFor', () => {
	it('returns the one-line description, or nothing when none is written', () => {
		expect(descriptionFor('slack')).toBe('Channels and triggers')
		expect(descriptionFor('github')).toBe('Pull requests')
		expect(descriptionFor('notion')).toBeUndefined()
		expect(descriptionFor('brand-new-provider')).toBeUndefined()
	})
})

describe('popularProviders', () => {
	it('lists the featured tools in their set order', () => {
		expect(popularProviders()).toEqual([
			'gmail',
			'google-calendar',
			'slack',
			'github',
			'google-drive',
			'notion',
			'linear',
			'hubspot',
		])
	})

	it('leaves out tools with no featured entry', () => {
		expect(popularProviders()).not.toContain('stripe')
	})
})

describe('isNewProvider', () => {
	// Figma was added on 2026-11-22.
	it('is true up to 30 days after the added date', () => {
		expect(isNewProvider('figma', new Date('2026-11-22T12:00:00Z'))).toBe(true)
		expect(isNewProvider('figma', new Date('2026-12-22T00:00:00Z'))).toBe(true)
	})

	it('is false once the 30 days have passed', () => {
		expect(isNewProvider('figma', new Date('2026-12-23T00:00:00Z'))).toBe(false)
	})

	it('is false before the added date', () => {
		expect(isNewProvider('figma', new Date('2026-11-21T00:00:00Z'))).toBe(false)
	})

	it('is false for a tool with no added date or an unknown tool', () => {
		expect(isNewProvider('gmail', new Date('2026-11-24T00:00:00Z'))).toBe(false)
		expect(isNewProvider('brand-new-provider')).toBe(false)
	})
})

describe('newProviders', () => {
	it('lists tools inside the window, newest first', () => {
		const list = newProviders(new Date('2026-11-24T00:00:00Z'))
		expect(list).toContain('figma')
		expect(list).toContain('wix')
		expect(list.indexOf('wix')).toBeLessThan(list.indexOf('figma'))
		expect(list).not.toContain('gmail')
	})

	it('is empty when nothing was added in the last 30 days', () => {
		expect(newProviders(new Date('2027-06-01T00:00:00Z'))).toEqual([])
	})
})

describe('addedOnFor', () => {
	it('returns the date or nothing', () => {
		expect(addedOnFor('figma')).toBe('2026-11-22')
		expect(addedOnFor('gmail')).toBeUndefined()
	})
})
