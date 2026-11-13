import type { FlowErrorCategory, FlowStepName } from '@maskin/shared'
import { trackFlowError, trackFlowStep } from './flow-events'

// The connect-by-sign-in journey (tracking plan, row 7) as flow_step and flow_error. The flow_id
// is minted by the connect route and sealed into the OAuth state, so the callback, which runs on
// a request that starts at the provider's own page, reports on the same flow. A state minted
// before this shipped has no flow_id and sends nothing.
type ConnectStep = FlowStepName<'integration_connect'>

interface ConnectFlowBase {
	flowId: string | undefined
	provider: string
	workspaceId: string
	actorId: string
}

/** One step of the connect flow. Best-effort and not awaited. */
export function trackConnectStep(p: ConnectFlowBase & { step: ConnectStep }): void {
	if (!p.flowId) return
	void trackFlowStep({ ...p, flowId: p.flowId, flow: 'integration_connect' })
}

/** A failure at a step of the connect flow, with a category from the fixed list. */
export function trackConnectError(
	p: ConnectFlowBase & { step: ConnectStep; errorCategory: FlowErrorCategory },
): void {
	if (!p.flowId) return
	void trackFlowError({ ...p, flowId: p.flowId, flow: 'integration_connect' })
}
