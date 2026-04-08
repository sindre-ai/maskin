import { describe, expect, it } from 'vitest'
import type { WorkspaceSettings } from '../../lib/types'
import { executeImport } from '../../services/import-processor'
import { createTestContext } from '../setup'

const defaultSettings: WorkspaceSettings = {
	display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
	statuses: {
		insight: ['new', 'processing'],
		bet: ['signal', 'proposed'],
		task: ['todo', 'in_progress', 'done'],
	},
	field_definitions: {},
	relationship_types: ['informs', 'breaks_into'],
	custom_extensions: {},
	enabled_modules: ['work'],
	max_concurrent_sessions: 5,
	llm_keys: {},
}

const workspaceId = 'ws-1'
const actorId = 'actor-1'
const importId = 'import-1'

function makeObj(id: string, type: string) {
	return { id, type, title: `Title ${id}`, workspaceId, status: 'new', createdBy: actorId }
}

function makeRel(id: string) {
	return { id, sourceId: 'src', targetId: 'tgt', type: 'informs' }
}

describe('executeImport', () => {
	it('creates objects from a single type mapping', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [
			{ name: 'Alpha', description: 'Desc A' },
			{ name: 'Beta', description: 'Desc B' },
		]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		}

		mockResults.insert = [makeObj('obj-1', 'task'), makeObj('obj-2', 'task')]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(2)
		expect(result.errorCount).toBe(0)
		expect(result.relationshipCount).toBe(0)
		expect(result.relationshipErrorCount).toBe(0)
		expect(result.errors).toHaveLength(0)
	})

	it('creates multiple objects per row with multi-type mappings', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [{ name: 'Feature X', description: 'Build it' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [],
		}

		// Both type mappings produce objects from the same row
		mockResults.insert = [makeObj('obj-1', 'task'), makeObj('obj-2', 'insight')]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		// 1 row × 2 type mappings = 2 objects
		expect(result.successCount).toBe(2)
		expect(result.errorCount).toBe(0)
	})

	it('skips type mapping when row has no matching non-skipped values', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [{ name: 'Alpha', description: '' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					// description is empty for this row, so this type mapping should be skipped
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [],
		}

		// Only the task mapping produces an object
		mockResults.insert = [makeObj('obj-1', 'task')]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(1)
	})

	it('creates relationships between objects from the same row', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [{ name: 'Feature', description: 'Research' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [{ sourceType: 'insight', relationshipType: 'informs', targetType: 'task' }],
		}

		// Pass 1: object creation returns both objects
		// Pass 2: relationship creation returns the relationship
		mockResults.insertQueue = [
			[makeObj('task-1', 'task'), makeObj('insight-1', 'insight')], // objects
			[], // events
			[makeRel('rel-1')], // relationships
			[], // relationship events
		]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(2)
		expect(result.relationshipCount).toBe(1)
		expect(result.relationshipErrorCount).toBe(0)
	})

	it('skips relationships when source or target object was not created', async () => {
		const { db, mockResults } = createTestContext()
		// Row where only task mapping produces an object (description is empty)
		const rows = [{ name: 'Solo task', description: '' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [{ sourceType: 'insight', relationshipType: 'informs', targetType: 'task' }],
		}

		// Only task is created, insight mapping returns null (empty description)
		mockResults.insert = [makeObj('task-1', 'task')]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(1)
		// No relationships created because insight was not created for this row
		expect(result.relationshipCount).toBe(0)
	})

	it('creates relationships across multiple rows', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [
			{ name: 'Feature A', description: 'Research A' },
			{ name: 'Feature B', description: 'Research B' },
		]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [{ sourceType: 'insight', relationshipType: 'informs', targetType: 'task' }],
		}

		mockResults.insertQueue = [
			// Pass 1: 4 objects (2 rows × 2 types)
			[
				makeObj('task-1', 'task'),
				makeObj('insight-1', 'insight'),
				makeObj('task-2', 'task'),
				makeObj('insight-2', 'insight'),
			],
			[], // events
			// Pass 2: 2 relationships (one per row)
			[makeRel('rel-1'), makeRel('rel-2')],
			[], // relationship events
		]

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(4)
		expect(result.relationshipCount).toBe(2)
	})

	it('tracks relationship errors separately from row errors', async () => {
		const rows = [{ name: 'Feature', description: 'Research' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
				{
					objectType: 'insight',
					columns: [
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [{ sourceType: 'insight', relationshipType: 'informs', targetType: 'task' }],
		}

		// Build a custom mock DB that throws on the 3rd insert (relationship insert)
		let insertCallCount = 0
		const objectResults = [makeObj('task-1', 'task'), makeObj('insight-1', 'insight')]

		const createThrowingChain = () => {
			const chain: Record<string, unknown> = {}
			for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'returning']) {
				chain[m] = () => chain
			}
			chain.values = () => {
				chain.onConflictDoNothing = () => {
					chain.returning = () => chain
					// biome-ignore lint/suspicious/noThenProperty: mock
					chain.then = (_res: unknown, rej: (e: Error) => void) =>
						rej(new Error('DB constraint error'))
					chain.catch = (fn: (e: Error) => void) => fn(new Error('DB constraint error'))
					return chain
				}
				return chain
			}
			// biome-ignore lint/suspicious/noThenProperty: mock
			chain.then = (_res: unknown, rej: (e: Error) => void) => rej(new Error('DB constraint error'))
			chain.catch = (fn: (e: Error) => void) => fn(new Error('DB constraint error'))
			return chain
		}

		const createNormalChain = (returnValue?: unknown) => {
			const chain: Record<string, unknown> = {}
			for (const m of [
				'select',
				'from',
				'where',
				'limit',
				'offset',
				'orderBy',
				'insert',
				'values',
				'returning',
				'update',
				'set',
				'delete',
				'innerJoin',
				'onConflictDoUpdate',
				'onConflictDoNothing',
			]) {
				chain[m] = () => chain
			}
			// biome-ignore lint/suspicious/noThenProperty: mock
			chain.then = (resolve: (v: unknown) => void) => resolve(returnValue ?? [])
			chain.catch = () => chain
			return chain
		}

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const db = new Proxy({} as any, {
			get: (_target, prop) => {
				if (prop === 'insert') {
					return () => {
						insertCallCount++
						// 1st insert = objects, 2nd = events, 3rd = relationships (throw)
						if (insertCallCount === 3) return createThrowingChain()
						if (insertCallCount === 1) return createNormalChain(objectResults)
						return createNormalChain([])
					}
				}
				if (prop === 'transaction') {
					return async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
				}
				if (prop === 'update' || prop === 'select') {
					return () => createNormalChain([])
				}
				return () => createNormalChain()
			},
		})

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		expect(result.successCount).toBe(2)
		expect(result.errorCount).toBe(0)
		expect(result.relationshipErrorCount).toBe(1)
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]?.message).toContain('Relationship batch failed')
		expect(result.errors[0]?.row).toBe(-1)
	})

	it('handles batch transaction failure', async () => {
		const { db, mockResults } = createTestContext()
		const rows = [{ name: 'Alpha' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
					],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		}

		// Make the transaction callback throw by returning rejected insert
		mockResults.insert = (() => {
			throw new Error('Connection lost')
		}) as never

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const failingDb = new Proxy({} as any, {
			get: (_target, prop) => {
				if (prop === 'transaction') {
					return async () => {
						throw new Error('Connection lost')
					}
				}
				if (prop === 'update') {
					const chain: Record<string, unknown> = {}
					for (const m of ['set', 'where', 'returning']) {
						chain[m] = () => chain
					}
					// biome-ignore lint/suspicious/noThenProperty: mock
					chain.then = (resolve: (v: unknown) => void) => resolve([])
					chain.catch = () => chain
					return () => chain
				}
				return () => ({})
			},
		})

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			failingDb,
		)

		expect(result.successCount).toBe(0)
		expect(result.errorCount).toBe(1)
		expect(result.errors[0]?.message).toContain('Connection lost')
		expect(result.errors[0]?.row).toBe(1) // 1-based for user-facing
	})

	it('returns zero counts when no rows match any type mapping', async () => {
		const { db } = createTestContext()
		// Row with no title or content — mapRowForType returns null
		const rows = [{ age: '30' }]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{
							sourceColumn: 'age',
							targetField: 'metadata.age',
							transform: 'number' as const,
							skip: false,
						},
					],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		}

		const result = await executeImport(
			importId,
			rows,
			mapping,
			workspaceId,
			actorId,
			defaultSettings,
			db,
		)

		// Row has metadata but no title/content, so mapRowForType returns null
		expect(result.successCount).toBe(0)
		expect(result.errorCount).toBe(0)
	})
})
