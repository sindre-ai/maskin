import { describe, expect, it } from 'vitest'
import {
	type WaitingOnViewerStep,
	isWaitingOnViewer,
	useWaitingOnViewer,
} from '../../loops/waiting-on-viewer'

/**
 * Fixtures modelled on the `LoopStep` shape the D6a task extends. Only the
 * fields the predicate reads are set here — the reconciler and banner call
 * this with much richer objects, but structural typing lets a minimal fixture
 * exercise the exact same code path.
 */
const stepWaiting: WaitingOnViewerStep = { waitingOnViewer: true }
const stepIdle: WaitingOnViewerStep = { waitingOnViewer: false }

describe('isWaitingOnViewer', () => {
	it('returns true when waitingOnViewer is strictly true', () => {
		expect(isWaitingOnViewer(stepWaiting)).toBe(true)
	})

	it('returns false when waitingOnViewer is false', () => {
		expect(isWaitingOnViewer(stepIdle)).toBe(false)
	})

	it('returns false when waitingOnViewer is missing', () => {
		expect(isWaitingOnViewer({})).toBe(false)
	})

	it('returns false when waitingOnViewer is null', () => {
		expect(isWaitingOnViewer({ waitingOnViewer: null })).toBe(false)
	})

	it('returns false for null / undefined step', () => {
		expect(isWaitingOnViewer(null)).toBe(false)
		expect(isWaitingOnViewer(undefined)).toBe(false)
	})
})

describe('useWaitingOnViewer', () => {
	it('returns true when any step in the loop is waiting on the viewer', () => {
		const getSteps = (id: string) => (id === 'loop-1' ? [stepIdle, stepWaiting] : [])
		expect(useWaitingOnViewer('loop-1', getSteps)).toBe(true)
	})

	it('returns false when no step is waiting on the viewer', () => {
		const getSteps = () => [stepIdle, stepIdle]
		expect(useWaitingOnViewer('loop-1', getSteps)).toBe(false)
	})

	it('returns false for an empty steps array', () => {
		expect(useWaitingOnViewer('loop-1', () => [])).toBe(false)
	})

	it('returns false when the getter returns null or undefined', () => {
		expect(useWaitingOnViewer('loop-missing', () => null)).toBe(false)
		expect(useWaitingOnViewer('loop-missing', () => undefined)).toBe(false)
	})
})
