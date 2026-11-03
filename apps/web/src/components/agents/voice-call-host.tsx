import { VoiceCallDialog } from '@/components/agents/voice-call-dialog'
import { endVoiceCall, useActiveVoiceCall } from '@/lib/voice-active-call'

// Mounted once in the workspace layout so a call survives navigating between
// pages. The Call buttons only start a call; this owns the dialog.
export function VoiceCallHost() {
	const agent = useActiveVoiceCall()
	if (!agent) return null
	return (
		<VoiceCallDialog
			key={agent.id}
			agent={agent}
			open
			onOpenChange={(open) => {
				if (!open) endVoiceCall()
			}}
		/>
	)
}
