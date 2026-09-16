import { phaseCopy, phaseForStatus } from '@/components/timeline/phase-map'
import { describe, expect, it } from 'vitest'

describe('phaseForStatus', () => {
	it('maps shaping-phase statuses to SHAPING', () => {
		expect(phaseForStatus('signal')).toBe('SHAPING')
		expect(phaseForStatus('define')).toBe('SHAPING')
		expect(phaseForStatus('shaped')).toBe('SHAPING')
	})

	it('maps build-phase statuses to BUILT', () => {
		expect(phaseForStatus('active')).toBe('BUILT')
		expect(phaseForStatus('in_progress')).toBe('BUILT')
		expect(phaseForStatus('in_review')).toBe('BUILT')
	})

	it('maps ship-phase statuses to SHIPPED', () => {
		expect(phaseForStatus('live')).toBe('SHIPPED')
		expect(phaseForStatus('succeeded')).toBe('SHIPPED')
		expect(phaseForStatus('validated')).toBe('SHIPPED')
		expect(phaseForStatus('done')).toBe('SHIPPED')
	})

	it('maps terminal statuses to WRAPPED_UP', () => {
		expect(phaseForStatus('failed')).toBe('WRAPPED_UP')
		expect(phaseForStatus('archived')).toBe('WRAPPED_UP')
		expect(phaseForStatus('discarded')).toBe('WRAPPED_UP')
	})

	it('falls back to SHAPING for unmapped statuses', () => {
		expect(phaseForStatus('brand-new-status')).toBe('SHAPING')
		expect(phaseForStatus('')).toBe('SHAPING')
	})
})

describe('phaseCopy', () => {
	it('renders each phase pill verbatim with its glyph', () => {
		expect(phaseCopy('SHAPING')).toEqual({ glyph: '\u25D0', label: 'SHAPING' })
		expect(phaseCopy('BUILT')).toEqual({ glyph: '\u25D2', label: 'BUILT' })
		expect(phaseCopy('SHIPPED')).toEqual({ glyph: '\u25CF', label: 'SHIPPED' })
		expect(phaseCopy('WRAPPED_UP')).toEqual({ glyph: '\u25CC', label: 'WRAPPED UP' })
	})
})
