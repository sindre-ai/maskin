import { newFlowId, trackFlowError, trackFlowStep } from '@/lib/analytics'

/** Where a computer view was opened: the agent's page, a chat request card, or the chat's computers pane. */
export type ComputerViewFrom = 'agent_page' | 'chat_request_card' | 'chat_computers_pane'

/**
 * The `agent_computer` flow of one computer view, on mode changes only (tracking plan row 12):
 * view opened (from where), first frame (its duration is the time to first frame), take-over
 * started, take-over ended (its duration is how long the person drove), view closed. Never one
 * event per frame, and nothing from the picture. One flow id per view, so the steps join up
 * across the inline view and the popup.
 *
 * Whoever closes the view ends a take-over still in progress first, so the pair is always
 * complete and `take_over_ended` carries its duration whichever part unmounts first.
 */
export function createComputerViewFlow(from: ComputerViewFrom) {
	const flowId = newFlowId()
	const flow = 'agent_computer' as const
	let controlling = false
	let closed = false

	const takeOver = (on: boolean) => {
		if (controlling === on) return
		controlling = on
		trackFlowStep({ flow, step: on ? 'take_over_started' : 'take_over_ended', flowId })
	}

	return {
		opened() {
			closed = false
			trackFlowStep({ flow, step: 'view_opened', flowId, from })
		},
		/** The picture is live; `ms` is how long this connection took. */
		firstFrame(ms: number) {
			trackFlowStep({ flow, step: 'first_frame', flowId, durationMs: ms })
		},
		/** The stream ended on its own. `live` is whether a picture had been shown before it did. */
		connectionLost(live: boolean) {
			trackFlowError({
				flow,
				step: live ? 'first_frame' : 'view_opened',
				flowId,
				errorCategory: 'connection_lost',
			})
		},
		/** The person took over (`true`) or handed back (`false`). Repeats of the same state send nothing. */
		takeOver,
		closed() {
			if (closed) return
			takeOver(false)
			closed = true
			trackFlowStep({ flow, step: 'view_closed', flowId })
		},
	}
}

export type ComputerViewFlow = ReturnType<typeof createComputerViewFlow>
