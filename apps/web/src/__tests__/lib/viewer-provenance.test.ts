import { type AttachingObject, pickTarget, resolveProvenance } from '@/lib/viewer-provenance'
import { describe, expect, it } from 'vitest'

function makeAttacher(overrides: Partial<AttachingObject> = {}): AttachingObject {
	return {
		id: 'obj-1',
		title: 'Q3 Review',
		type: 'bet',
		driverId: 'actor-h1',
		driverType: 'human',
		attacherName: 'Sebk',
		attachedAt: '2026-09-01T09:00:00.000Z',
		targetArchived: false,
		archived: false,
		...overrides,
	}
}

describe('resolveProvenance — 6 variants + agent-attached-human-driver', () => {
	it('zero attachers → variant zero, strip hidden, send disabled (direct link)', () => {
		const r = resolveProvenance([])
		expect(r.variant).toBe('zero')
		expect(r.strip.kind).toBe('hidden')
		expect(r.strip.label).toBeNull()
		expect(r.crumb.prefix).toBeNull()
		expect(r.send).toBe('disabled')
		expect(r.defaultTarget).toBeNull()
	})

	it('one attacher → variant single, single-crumb, send enabled to that object', () => {
		const only = makeAttacher({ id: 'bet-42', title: 'Onboarding cleanup' })
		const r = resolveProvenance([only])
		expect(r.variant).toBe('single')
		expect(r.crumb.prefix).toEqual({ kind: 'single', object: only })
		expect(r.strip.kind).toBe('single')
		expect(r.strip.label).toBe('Attached to Onboarding cleanup — Sebk')
		expect(r.send).toBe('enabled')
		expect(r.defaultTarget).toBe(only)
		expect(r.targetDriverType).toBe('human')
	})

	it('two attachers → variant pair, dropdown crumb, arrived-from preselected (latest)', () => {
		const older = makeAttacher({
			id: 'a',
			title: 'A',
			attachedAt: '2026-09-01T00:00:00.000Z',
		})
		const newer = makeAttacher({
			id: 'b',
			title: 'B',
			attachedAt: '2026-09-04T00:00:00.000Z',
		})
		const r = resolveProvenance([older, newer])
		expect(r.variant).toBe('pair')
		if (r.crumb.prefix && r.crumb.prefix.kind === 'dropdown') {
			expect(r.crumb.prefix.preselectedId).toBe('b')
			expect(r.crumb.prefix.options.map((o) => o.id)).toEqual(['b', 'a'])
		} else {
			throw new Error('expected dropdown crumb')
		}
		expect(r.send).toBe('enabled')
		expect(r.defaultTarget?.id).toBe('b')
	})

	it('three+ attachers → variant many, collapsed crumb, picker-required (no silent default)', () => {
		const attachers = [
			makeAttacher({ id: 'a', title: 'A' }),
			makeAttacher({ id: 'b', title: 'B' }),
			makeAttacher({ id: 'c', title: 'C' }),
			makeAttacher({ id: 'd', title: 'D' }),
		]
		const r = resolveProvenance(attachers)
		expect(r.variant).toBe('many')
		if (r.crumb.prefix && r.crumb.prefix.kind === 'collapsed') {
			expect(r.crumb.prefix.options.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd'])
		} else {
			throw new Error('expected collapsed crumb')
		}
		expect(r.strip.label).toBe('Attached to 4 objects')
		expect(r.send).toBe('picker-required')
		expect(r.defaultTarget).toBeNull()
		expect(r.targetDriverType).toBeNull()
	})

	it('only-archived attachers → variant archived, strip labels archived, send disabled', () => {
		const arch = makeAttacher({ id: 'x', title: 'Old bet', archived: true })
		const r = resolveProvenance([arch])
		expect(r.variant).toBe('archived')
		expect(r.strip.kind).toBe('archived')
		expect(r.strip.label).toBe('Attached to (archived): Old bet')
		expect(r.send).toBe('disabled')
	})

	it('attacher archived mid-review (targetArchived) → variant orphaned, "orphaned + re-attach" label, send disabled', () => {
		const orphaned = makeAttacher({ id: 'y', title: 'Sunset bet', targetArchived: true })
		const r = resolveProvenance([orphaned])
		expect(r.variant).toBe('orphaned')
		expect(r.strip.kind).toBe('orphaned')
		expect(r.strip.label).toBe('Orphaned: Sunset bet — re-attach')
		expect(r.send).toBe('disabled')
	})

	it('agent-attached, human-driver → single-attacher path, targetDriverType is human', () => {
		// Spec §Provenance special case: an agent attached the file, but the
		// object's driver is a human. The round still routes to the human
		// driver via the single-driver rule. This resolver just surfaces the
		// driver type so the panel can decide whether to lock with 🔒 Awaiting
		// agent response (agent driver) or not (human driver).
		const attacher = makeAttacher({
			id: 'obj-1',
			title: 'Investor deck',
			driverId: 'actor-human-1',
			driverType: 'human',
			attacherName: 'Product Designer',
		})
		const r = resolveProvenance([attacher])
		expect(r.variant).toBe('single')
		expect(r.send).toBe('enabled')
		expect(r.defaultTarget?.driverId).toBe('actor-human-1')
		expect(r.targetDriverType).toBe('human')
	})

	it('agent-driver single-attacher → same variant, targetDriverType is agent', () => {
		// Complements the case above — proves the resolver carries driverType
		// through so the panel can render the 🔒 Awaiting agent response lock.
		const attacher = makeAttacher({
			driverId: 'actor-agent-1',
			driverType: 'agent',
		})
		const r = resolveProvenance([attacher])
		expect(r.variant).toBe('single')
		expect(r.send).toBe('enabled')
		expect(r.targetDriverType).toBe('agent')
	})
})

describe('pickTarget — picker resolution', () => {
	it('resolves many-attachers to a specific target with send=enabled', () => {
		const attachers = [
			makeAttacher({ id: 'a', title: 'A' }),
			makeAttacher({ id: 'b', title: 'B' }),
			makeAttacher({ id: 'c', title: 'C' }),
		]
		const r = resolveProvenance(attachers)
		expect(r.send).toBe('picker-required')
		const picked = pickTarget(r, 'b')
		expect(picked.send).toBe('enabled')
		expect(picked.defaultTarget?.id).toBe('b')
	})

	it('ignores an unknown target id', () => {
		const r = resolveProvenance([makeAttacher({ id: 'a' })])
		const picked = pickTarget(r, 'unknown')
		expect(picked).toBe(r)
	})
})
