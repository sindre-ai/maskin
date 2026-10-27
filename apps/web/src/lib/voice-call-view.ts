import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import type { VoiceCallState } from '@/hooks/use-voice-call'
import { useSyncExternalStore } from 'react'

// What the live-call surfaces (panel, bar, header capsule) read. The call
// itself is owned by <VoiceCallDialog> in the workspace layout; once it is
// live, it publishes a snapshot here and the surfaces render wherever the page
// has room for them. Module-level for the same reason voice-active-call.ts is:
// the surfaces live on routes that unmount, the call must not.

export interface VoiceCallView {
	agent: VoiceCallAgent
	state: VoiceCallState
	/** Epoch ms the call went live; the clock counts from here. */
	liveSince: number
	/** The agent's latest spoken line, or null before it has said anything. */
	caption: string | null
	captionsOn: boolean
	speakerOn: boolean
	minimized: boolean
	toggleMute: () => void
	toggleSpeaker: () => void
	toggleCaptions: () => void
	setMinimized: (minimized: boolean) => void
	/** Open search without ending the call; the surface collapses to the bar. */
	pullUp: () => void
	end: () => void
}

let view: VoiceCallView | null = null
let composerSlot: HTMLElement | null = null
const listeners = new Set<() => void>()

function emit() {
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function publishVoiceCallView(next: VoiceCallView | null): void {
	view = next
	emit()
}

export function getVoiceCallView(): VoiceCallView | null {
	return view
}

export function useVoiceCallView(): VoiceCallView | null {
	return useSyncExternalStore(
		subscribe,
		() => view,
		() => null,
	)
}

/** The element above a thread's composer, where the dock and the bar sit. */
export function setVoiceCallComposerSlot(el: HTMLElement | null): void {
	composerSlot = el
	emit()
}

export function useVoiceCallComposerSlot(): HTMLElement | null {
	return useSyncExternalStore(
		subscribe,
		() => composerSlot,
		() => null,
	)
}

/** Labels for the status line, shared by the panel, dock and bar. */
export function voiceCallStatus(state: VoiceCallState): string {
	switch (state) {
		case 'live-user-speaking':
			return 'Listening'
		case 'live-agent-thinking':
			return 'Working on it'
		case 'live-muted':
			return 'Microphone off'
		case 'reconnecting':
			return 'Reconnecting'
		default:
			return 'Speaking'
	}
}
