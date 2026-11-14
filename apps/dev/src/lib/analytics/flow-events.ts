import {
	type FlowErrorCategory,
	type FlowName,
	type FlowStepDetail,
	type FlowStepName,
	buildFlowErrorProps,
	buildFlowStepProps,
	createFlowClock,
} from '@maskin/shared'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// The server side of the two generic flow events (flow and step names live in
// `@maskin/shared` analytics-flows; an unknown name fails the type check).
// `duration_ms` is the time since the previous step with the same flow_id in this
// process; a flow that spans requests handled by another replica, or a restart,
// passes `durationMs` itself or reads as a first step.
const flowClock = createFlowClock()

interface FlowEventBase<F extends FlowName> {
	workspaceId: string
	actorId: string
	flow: F
	step: FlowStepName<F>
	flowId: string
	/** Only for flows about one provider (the integration ones). */
	provider?: string
}

/** One `flow_step`. Ids, names and a number only. Best-effort: never throws, so callers fire it without awaiting. */
export async function trackFlowStep<F extends FlowName>(
	p: FlowEventBase<F> & { durationMs?: number | null; detail?: FlowStepDetail },
): Promise<void> {
	const props = buildFlowStepProps({
		flow: p.flow,
		step: p.step,
		flowId: p.flowId,
		surface: 'backend',
		durationMs: p.durationMs !== undefined ? p.durationMs : flowClock.tick(p.flowId),
		provider: p.provider,
		detail: p.detail,
	})
	if (!props) return
	try {
		await capturePosthogEvent('flow_step', p.actorId, {
			...props,
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
		})
	} catch (err) {
		logger.warn('Failed to emit flow_step', { flow: p.flow, step: p.step, error: String(err) })
	}
}

/** One `flow_error`, with a category from the fixed list and never the error text. Best-effort: never throws. */
export async function trackFlowError<F extends FlowName>(
	p: FlowEventBase<F> & { errorCategory: FlowErrorCategory },
): Promise<void> {
	const props = buildFlowErrorProps({
		flow: p.flow,
		step: p.step,
		flowId: p.flowId,
		surface: 'backend',
		errorCategory: p.errorCategory,
		provider: p.provider,
	})
	if (!props) return
	try {
		await capturePosthogEvent('flow_error', p.actorId, {
			...props,
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
		})
	} catch (err) {
		logger.warn('Failed to emit flow_error', { flow: p.flow, step: p.step, error: String(err) })
	}
}
