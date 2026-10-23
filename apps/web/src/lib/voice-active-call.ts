import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import { useSyncExternalStore } from 'react'

// The call in progress, if any. Module-level on purpose: the Call buttons live
// on different surfaces (agent rows, detail header, thread header, new-chat
// composer) that unmount on navigation, but the call itself must outlive them.
// Buttons only start a call here; <VoiceCallHost> in the workspace layout owns
// the dialog and so keeps it mounted across route changes. One call at a time,
// matching the server's 409 for a second live session.

let activeCall: VoiceCallAgent | null = null
const listeners = new Set<() => void>()

function emit() {
	for (const listener of listeners) listener()
}

export function startVoiceCall(agent: VoiceCallAgent): void {
	if (activeCall) return
	activeCall = agent
	emit()
}

export function endVoiceCall(): void {
	if (!activeCall) return
	activeCall = null
	emit()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function useActiveVoiceCall(): VoiceCallAgent | null {
	return useSyncExternalStore(
		subscribe,
		() => activeCall,
		() => null,
	)
}
