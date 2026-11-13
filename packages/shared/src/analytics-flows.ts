/**
 * The step vocabulary behind the two generic flow events, `flow_step` and
 * `flow_error`, for journeys that have no screen or route of their own (see
 * "Step vocabulary" on the product tracking plan). The web app, the server and the
 * iPhone app share these names, so a new flow or step is added here and nowhere
 * else: a name that is not in `FLOW_STEPS` fails the type check at the call site.
 *
 * Abandon is never an event. It is read as "no next step within N minutes".
 * Properties are names, ids, a number and a category only, never message text.
 */
export const FLOW_STEPS = {
	// Sign-up to first result. Steps from the tracking plan, row 3.
	signup_to_first_result: [
		'workspace_ready',
		'first_agent',
		'intro_shown',
		'intro_clicked',
		'first_run_started',
		'first_run_completed',
		'result_opened',
	],
	// Key capture cards inside chat have no route of their own. Built-in sign-in
	// providers use the integration_* server events instead (row 7).
	integration_key_capture: ['card_shown', 'key_submitted', 'connected'],
	// Agent computer view and take-over, on mode changes only (row 12).
	agent_computer: ['view_opened', 'take_over_started', 'take_over_ended', 'view_closed'],
	// First launch of the iPhone app (row 11).
	iphone_first_launch: [
		'first_launch',
		'signed_in',
		'first_content',
		'push_permission_shown',
		'push_permission_granted',
		'push_permission_denied',
		'chat_sent',
		'reply_received',
		'computer_view_opened',
	],
} as const satisfies Record<string, readonly string[]>

export type FlowName = keyof typeof FLOW_STEPS
export type FlowStepName<F extends FlowName = FlowName> = (typeof FLOW_STEPS)[F][number]

/** The surface sending the event: the web app, the server or the iPhone app. */
export type FlowSurface = 'web' | 'backend' | 'iphone'

/**
 * Why a step failed, from a fixed list. Never an error message: those can hold
 * user text. Anything outside the list is sent as `unknown`.
 */
export const FLOW_ERROR_CATEGORIES = [
	'network',
	'timeout',
	'auth_failed',
	'permission_denied',
	'not_found',
	'rate_limited',
	'provider_error',
	'validation',
	'connection_lost',
	'unknown',
] as const

export type FlowErrorCategory = (typeof FLOW_ERROR_CATEGORIES)[number]

// Type aliases, not interfaces: an interface has no implicit index signature, so it
// would not fit the web's `AnalyticsProps` record when passed straight to trackEvent.
export type FlowStepProps = {
	flow: string
	step: string
	flow_id: string
	surface: FlowSurface
	/** Milliseconds since the previous step of the same flow_id; null on the first step. */
	duration_ms: number | null
}

export type FlowErrorProps = {
	flow: string
	step: string
	flow_id: string
	surface: FlowSurface
	error_category: FlowErrorCategory
}

export function isFlowStep(flow: string, step: string): boolean {
	// Own keys only: a flow like "toString" would otherwise find an inherited function.
	if (!Object.prototype.hasOwnProperty.call(FLOW_STEPS, flow)) return false
	const steps: readonly string[] | undefined = (FLOW_STEPS as Record<string, readonly string[]>)[
		flow
	]
	return steps?.includes(step) ?? false
}

function toErrorCategory(value: string): FlowErrorCategory {
	return (FLOW_ERROR_CATEGORIES as readonly string[]).includes(value)
		? (value as FlowErrorCategory)
		: 'unknown'
}

/**
 * The properties of one `flow_step`, or null when the flow or step is not in the
 * vocabulary (a call that got past the type check, for example from plain JS):
 * the event is dropped rather than sent under a name nobody can chart.
 */
export function buildFlowStepProps(p: {
	flow: string
	step: string
	flowId: string
	surface: FlowSurface
	durationMs: number | null
}): FlowStepProps | null {
	if (!p.flowId || !isFlowStep(p.flow, p.step)) return null
	return {
		flow: p.flow,
		step: p.step,
		flow_id: p.flowId,
		surface: p.surface,
		duration_ms: p.durationMs,
	}
}

/** The properties of one `flow_error`; null on the same terms as `buildFlowStepProps`. */
export function buildFlowErrorProps(p: {
	flow: string
	step: string
	flowId: string
	surface: FlowSurface
	errorCategory: string
}): FlowErrorProps | null {
	if (!p.flowId || !isFlowStep(p.flow, p.step)) return null
	return {
		flow: p.flow,
		step: p.step,
		flow_id: p.flowId,
		surface: p.surface,
		error_category: toErrorCategory(p.errorCategory),
	}
}

const MAX_TRACKED_FLOWS = 500

/**
 * Remembers when each flow_id last stepped, so the next step can say how long it
 * took. In memory per process (a page load in the browser, a server process on the
 * backend): the first step after a reload or restart reads as the first step. The
 * oldest flow ids are dropped past 500 so it cannot grow without bound.
 */
export function createFlowClock(now: () => number = Date.now) {
	const last = new Map<string, number>()
	return {
		/** Milliseconds since the previous tick of this flow_id (null on the first), and records this one. */
		tick(flowId: string): number | null {
			const t = now()
			const prev = last.get(flowId)
			last.delete(flowId)
			last.set(flowId, t)
			if (last.size > MAX_TRACKED_FLOWS) {
				const oldest = last.keys().next().value
				if (oldest !== undefined) last.delete(oldest)
			}
			return prev === undefined ? null : Math.max(0, t - prev)
		},
	}
}
