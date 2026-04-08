import { describe, expect, it } from 'vitest'
import type { WorkspaceSettings } from '../../lib/types'
import { generateMapping, parseFile } from '../../services/import-processor'

const defaultSettings: WorkspaceSettings = {
	display_names: { insight: 'Insight', bet: 'Bet', task: 'Task', contact: 'Contact' },
	statuses: {
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed'],
		task: ['todo', 'in_progress', 'done', 'blocked'],
		contact: ['active', 'inactive'],
	},
	field_definitions: {
		contact: [
			{ name: 'email', type: 'text', required: false },
			{ name: 'phone', type: 'text', required: false },
			{ name: 'priority', type: 'enum', required: false, values: ['high', 'medium', 'low'] },
			{ name: 'age', type: 'number', required: false },
			{ name: 'active', type: 'boolean', required: false },
		],
	},
	relationship_types: ['informs', 'breaks_into'],
	custom_extensions: {},
	enabled_modules: ['work'],
	max_concurrent_sessions: 5,
	llm_keys: {},
}

describe('parseFile', () => {
	describe('CSV parsing', () => {
		it('parses a simple CSV file', () => {
			const csv = 'name,email,status\nAlice,alice@test.com,active\nBob,bob@test.com,inactive'
			const result = parseFile(Buffer.from(csv), 'csv')

			expect(result.columns).toEqual(['name', 'email', 'status'])
			expect(result.rows).toHaveLength(2)
			expect(result.rows[0]).toEqual({
				name: 'Alice',
				email: 'alice@test.com',
				status: 'active',
			})
		})

		it('handles CSV with BOM', () => {
			const csv = '\ufeffname,email\nAlice,alice@test.com'
			const result = parseFile(Buffer.from(csv), 'csv')
			expect(result.columns).toEqual(['name', 'email'])
		})

		it('throws on empty CSV', () => {
			const csv = 'name,email'
			expect(() => parseFile(Buffer.from(csv), 'csv')).toThrow('no data rows')
		})

		it('trims whitespace from values', () => {
			const csv = 'name,email\n  Alice  ,  alice@test.com  '
			const result = parseFile(Buffer.from(csv), 'csv')
			expect(result.rows[0]?.name).toBe('Alice')
			expect(result.rows[0]?.email).toBe('alice@test.com')
		})
	})

	describe('JSON parsing', () => {
		it('parses a JSON array of objects', () => {
			const json = JSON.stringify([
				{ name: 'Alice', email: 'alice@test.com' },
				{ name: 'Bob', email: 'bob@test.com' },
			])
			const result = parseFile(Buffer.from(json), 'json')

			expect(result.columns).toEqual(['name', 'email'])
			expect(result.rows).toHaveLength(2)
		})

		it('converts non-string values to strings', () => {
			const json = JSON.stringify([{ name: 'Alice', age: 30, active: true }])
			const result = parseFile(Buffer.from(json), 'json')

			expect(result.rows[0]?.age).toBe('30')
			expect(result.rows[0]?.active).toBe('true')
		})

		it('handles null values as empty strings', () => {
			const json = JSON.stringify([{ name: 'Alice', email: null }])
			const result = parseFile(Buffer.from(json), 'json')
			expect(result.rows[0]?.email).toBe('')
		})

		it('throws on non-array JSON', () => {
			const json = JSON.stringify({ name: 'Alice' })
			expect(() => parseFile(Buffer.from(json), 'json')).toThrow('array of objects')
		})

		it('throws on empty array', () => {
			const json = JSON.stringify([])
			expect(() => parseFile(Buffer.from(json), 'json')).toThrow('no data')
		})

		it('collects all unique keys across objects', () => {
			const json = JSON.stringify([
				{ name: 'Alice', email: 'a@test.com' },
				{ name: 'Bob', phone: '123' },
			])
			const result = parseFile(Buffer.from(json), 'json')

			expect(result.columns).toContain('name')
			expect(result.columns).toContain('email')
			expect(result.columns).toContain('phone')
			// Missing keys filled with empty string
			expect(result.rows[0]?.phone).toBe('')
			expect(result.rows[1]?.email).toBe('')
		})
	})

	it('throws on unsupported file type', () => {
		expect(() => parseFile(Buffer.from(''), 'xlsx')).toThrow('Unsupported file type')
	})
})

describe('generateMapping', () => {
	it('returns a typeMappings array with one entry', () => {
		const columns = ['name']
		const sampleRows = [{ name: 'Alice' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)

		expect(mapping.typeMappings).toHaveLength(1)
		expect(mapping.typeMappings[0]?.objectType).toBe('insight')
		expect(mapping.relationships).toEqual([])
	})

	it('maps reserved field aliases', () => {
		const columns = ['name', 'description', 'status']
		const sampleRows = [{ name: 'Alice', description: 'A contact', status: 'active' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const titleCol = cols.find((c) => c.targetField === 'title')
		expect(titleCol?.sourceColumn).toBe('name')

		const contentCol = cols.find((c) => c.targetField === 'content')
		expect(contentCol?.sourceColumn).toBe('description')

		const statusCol = cols.find((c) => c.targetField === 'status')
		expect(statusCol?.sourceColumn).toBe('status')
	})

	it('matches columns to field definitions by exact name', () => {
		const columns = ['name', 'email', 'phone']
		const sampleRows = [{ name: 'Alice', email: 'a@test.com', phone: '123' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const emailCol = cols.find((c) => c.sourceColumn === 'email')
		expect(emailCol?.targetField).toBe('metadata.email')
		expect(emailCol?.skip).toBe(false)

		const phoneCol = cols.find((c) => c.sourceColumn === 'phone')
		expect(phoneCol?.targetField).toBe('metadata.phone')
	})

	it('defaults to first valid type when no type column', () => {
		const columns = ['name']
		const sampleRows = [{ name: 'Alice' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)

		expect(mapping.typeMappings[0]?.objectType).toBe('insight')
	})

	it('sets default status from first status of inferred type', () => {
		const columns = ['name']
		const sampleRows = [{ name: 'Alice' }]
		const mapping = generateMapping(columns, sampleRows, {
			...defaultSettings,
			statuses: { task: ['todo', 'done'] },
		})

		expect(mapping.typeMappings[0]?.defaultStatus).toBe('todo')
	})

	it('marks unmatched columns as skipped metadata', () => {
		const columns = ['name', 'unknown_field']
		const sampleRows = [{ name: 'Alice', unknown_field: 'value' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const unknownCol = cols.find((c) => c.sourceColumn === 'unknown_field')
		expect(unknownCol?.skip).toBe(true)
		expect(unknownCol?.targetField).toMatch(/^metadata\./)
	})

	it('assigns number transform for number fields', () => {
		const columns = ['name', 'age']
		const sampleRows = [{ name: 'Alice', age: '30' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const ageCol = cols.find((c) => c.sourceColumn === 'age')
		expect(ageCol?.transform).toBe('number')
		expect(ageCol?.targetField).toBe('metadata.age')
	})

	it('assigns boolean transform for boolean fields', () => {
		const columns = ['name', 'active']
		const sampleRows = [{ name: 'Alice', active: 'true' }]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const activeCol = cols.find((c) => c.sourceColumn === 'active')
		expect(activeCol?.transform).toBe('boolean')
	})

	it('matches enum fields by sample values', () => {
		const columns = ['name', 'urgency']
		const sampleRows = [
			{ name: 'Alice', urgency: 'high' },
			{ name: 'Bob', urgency: 'low' },
		]
		const mapping = generateMapping(columns, sampleRows, defaultSettings)
		const cols = mapping.typeMappings[0]!.columns

		const urgencyCol = cols.find((c) => c.sourceColumn === 'urgency')
		expect(urgencyCol?.targetField).toBe('metadata.priority')
		expect(urgencyCol?.skip).toBe(false)
	})
})
