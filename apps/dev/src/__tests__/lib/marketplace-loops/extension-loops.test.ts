import { describe, expect, it } from 'vitest'
import {
	CRM_EXTENSION_ITEMS,
	CRM_EXTENSION_LOOP,
	KNOWLEDGE_EXTENSION_ITEMS,
	KNOWLEDGE_EXTENSION_LOOP,
	WORK_EXTENSION_ITEMS,
	WORK_EXTENSION_LOOP,
} from '../../../lib/marketplace-loops/extension-loops'

const EXTENSION_LOOPS = [
	{ loop: WORK_EXTENSION_LOOP, items: WORK_EXTENSION_ITEMS, extensionId: 'work' },
	{ loop: KNOWLEDGE_EXTENSION_LOOP, items: KNOWLEDGE_EXTENSION_ITEMS, extensionId: 'knowledge' },
	{ loop: CRM_EXTENSION_LOOP, items: CRM_EXTENSION_ITEMS, extensionId: 'crm' },
] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('extension loop definitions', () => {
	it('uses the expected slugs and shares one use case', () => {
		expect(WORK_EXTENSION_LOOP.slug).toBe('work-extension-loop')
		expect(KNOWLEDGE_EXTENSION_LOOP.slug).toBe('knowledge-extension-loop')
		expect(CRM_EXTENSION_LOOP.slug).toBe('crm-extension-loop')
		for (const { loop } of EXTENSION_LOOPS) {
			expect(loop.useCase).toBe('Extensions')
			expect(loop.version).toBe('1.0.0')
			expect(loop.name.length).toBeGreaterThan(0)
			expect(loop.description.length).toBeGreaterThan(0)
		}
	})

	// The marketplace card, the "Install extension" button, and the item-type
	// sections all key off a loop shipping exactly one extension and nothing
	// else. Adding an agent to one of these loops is fine; adding a *second*
	// extension is not, and would silently change how the card reads.
	it('ships exactly one extension per loop, naming the extension it enables', () => {
		for (const { items, extensionId } of EXTENSION_LOOPS) {
			expect(items.length).toBe(1)
			expect(items[0]?.extensionId).toBe(extensionId)
			expect(items[0]?.name.length).toBeGreaterThan(0)
		}
	})

	// These loops first shipped as '*-module-loop'. The rename needed migration
	// 0053 to delete the orphaned rows the slug-keyed upsert left behind, so
	// reintroducing a retired slug would resurrect a loop that migration removed.
	it('uses no retired module-era slug', () => {
		for (const { loop } of EXTENSION_LOOPS) {
			expect(loop.slug).not.toMatch(/module/)
			expect(loop.slug.endsWith('-extension-loop')).toBe(true)
		}
	})

	// source_item_id is a `uuid NOT NULL` column and the dedup/version-push
	// identity for the item — a malformed or reused id would silently break
	// both. These are hand-authored constants, so assert their shape here.
	it('gives every extension a distinct, well-formed source item id', () => {
		const ids = EXTENSION_LOOPS.flatMap(({ items }) => items.map((e) => e.id))
		expect(ids.length).toBe(3)
		expect(new Set(ids).size).toBe(3)
		for (const id of ids) expect(id).toMatch(UUID_RE)
	})
})
