/**
 * Lifecycle-phase inference for the object detail timeline.
 *
 * v4 groups statuses into four labelled phases and stamps a divider on the
 * timeline where an event crosses a phase boundary. The mapping is exhaustive
 * over the statuses this repo actually uses: anything outside the map lands in
 * `SHAPING` as the safe default, so an object with a legacy or workspace-custom
 * status still gets a phase rather than an empty rail.
 *
 * Copy is verbatim from the SPEC — pill glyph + uppercase label — and pill
 * dividers are static, not collapsible: the phase is a chapter heading, not a
 * fold. See D10 in [Task 0290c05a](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/0290c05a-2195-42a7-a797-edabd1dcee81).
 */

export type LifecyclePhase = 'SHAPING' | 'BUILT' | 'SHIPPED' | 'WRAPPED_UP'

const PHASE_BY_STATUS: Record<string, LifecyclePhase> = {
	signal: 'SHAPING',
	define: 'SHAPING',
	shaped: 'SHAPING',
	active: 'BUILT',
	in_progress: 'BUILT',
	in_review: 'BUILT',
	live: 'SHIPPED',
	succeeded: 'SHIPPED',
	validated: 'SHIPPED',
	done: 'SHIPPED',
	failed: 'WRAPPED_UP',
	archived: 'WRAPPED_UP',
	discarded: 'WRAPPED_UP',
}

/** Every status the object may sit in, mapped to its phase. */
export function phaseForStatus(status: string): LifecyclePhase {
	return PHASE_BY_STATUS[status] ?? 'SHAPING'
}

interface PhaseCopy {
	glyph: string
	label: string
}

const PHASE_COPY: Record<LifecyclePhase, PhaseCopy> = {
	SHAPING: { glyph: '\u25D0', label: 'SHAPING' },
	BUILT: { glyph: '\u25D2', label: 'BUILT' },
	SHIPPED: { glyph: '\u25CF', label: 'SHIPPED' },
	WRAPPED_UP: { glyph: '\u25CC', label: 'WRAPPED UP' },
}

export function phaseCopy(phase: LifecyclePhase): PhaseCopy {
	return PHASE_COPY[phase]
}
