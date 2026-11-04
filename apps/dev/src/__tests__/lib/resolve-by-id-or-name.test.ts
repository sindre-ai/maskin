import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolveByIdOrName } from '../../lib/resolve-by-id-or-name'

type Row = { id: string; name: string; workspaceId: string }

function makeFinders(rows: Row[], workspaceId: string) {
	const findById = vi.fn(async (id: string) =>
		rows.find((r) => r.workspaceId === workspaceId && r.id === id),
	)
	const findByName = vi.fn(async (name: string) =>
		rows.filter((r) => r.workspaceId === workspaceId && r.name === name),
	)
	return { findById, findByName }
}

describe('resolveByIdOrName', () => {
	const workspaceId = randomUUID()

	it('returns the row via id when a UUID matches an id', async () => {
		const row = { id: randomUUID(), name: 'my-skill', workspaceId }
		const finders = makeFinders([row], workspaceId)

		const result = await resolveByIdOrName({ ref: row.id, ...finders })

		expect(result).toEqual({ kind: 'found', row, via: 'id' })
		expect(finders.findByName).not.toHaveBeenCalled()
	})

	it('falls back to the name when a UUID matches no id but matches a name', async () => {
		const uuidName = randomUUID()
		const row = { id: randomUUID(), name: uuidName, workspaceId }
		const finders = makeFinders([row], workspaceId)

		const result = await resolveByIdOrName({ ref: uuidName, ...finders })

		expect(result).toEqual({ kind: 'found', row, via: 'name' })
		expect(finders.findById).toHaveBeenCalledWith(uuidName)
	})

	it('returns none when a UUID matches neither an id nor a name', async () => {
		const finders = makeFinders([{ id: randomUUID(), name: 'other', workspaceId }], workspaceId)

		const result = await resolveByIdOrName({ ref: randomUUID(), ...finders })

		expect(result).toEqual({ kind: 'none' })
	})

	it('returns the row via name for a plain name, without trying the id', async () => {
		const row = { id: randomUUID(), name: 'my-skill', workspaceId }
		const finders = makeFinders([row], workspaceId)

		const result = await resolveByIdOrName({ ref: 'my-skill', ...finders })

		expect(result).toEqual({ kind: 'found', row, via: 'name' })
		expect(finders.findById).not.toHaveBeenCalled()
	})

	it('returns none for a plain name with no match', async () => {
		const finders = makeFinders([{ id: randomUUID(), name: 'my-skill', workspaceId }], workspaceId)

		const result = await resolveByIdOrName({ ref: 'missing', ...finders })

		expect(result).toEqual({ kind: 'none' })
	})

	it('does not trim or case-fold the name', async () => {
		const row = { id: randomUUID(), name: 'my-skill', workspaceId }
		const finders = makeFinders([row], workspaceId)

		expect(await resolveByIdOrName({ ref: ' my-skill', ...finders })).toEqual({ kind: 'none' })
		expect(await resolveByIdOrName({ ref: 'My-Skill', ...finders })).toEqual({ kind: 'none' })
	})

	it('returns ambiguous with every match listed by id and name, sorted by id', async () => {
		const high = { id: 'ffffffff-0000-4000-8000-000000000000', name: 'twin' }
		const low = { id: '00000000-0000-4000-8000-000000000000', name: 'twin' }
		const findById = vi.fn(async () => undefined)
		const findByName = vi.fn(async () => [high, low])

		const result = await resolveByIdOrName({ ref: 'twin', findById, findByName })

		expect(result).toEqual({ kind: 'ambiguous', matches: [low, high] })
	})

	it('returns none for an id that belongs to another workspace', async () => {
		const otherWorkspaceId = randomUUID()
		const row = { id: randomUUID(), name: 'my-skill', workspaceId: otherWorkspaceId }
		const finders = makeFinders([row], workspaceId)

		const result = await resolveByIdOrName({ ref: row.id, ...finders })

		expect(result).toEqual({ kind: 'none' })
	})
})
