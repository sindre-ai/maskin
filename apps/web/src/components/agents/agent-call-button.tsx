import { VoiceCallDialog } from '@/components/agents/voice-call-dialog'
import { Button } from '@/components/ui/button'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import type { ActorResponse } from '@/lib/api'
import { Phone } from 'lucide-react'
import { useEffect, useState } from 'react'

// One boundary per feature — this component reads `voice-mode-v1` and renders
// nothing when the flag is off, so the header composition stays trivial and the
// flag is not scattered across per-element checks. When the flag is deleted
// (feature ships to everyone), this component's guard is the only site to
// clean up.
const VOICE_MODE_V1_ID = 'voice-mode-v1'

export function AgentCallButton({ agent }: { agent: ActorResponse }) {
	const enabled = useFeatureFlag(VOICE_MODE_V1_ID)
	const [open, setOpen] = useState(false)

	// `V` opens the dialog when the agent detail is focused (anywhere on the
	// page counts, provided the user isn't typing in an input). Global scope
	// mirrors the SPEC: "V opens when the agent detail is focused."
	useEffect(() => {
		if (!enabled) return
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (e.key.toLowerCase() !== 'v') return
			const target = e.target as HTMLElement | null
			if (
				target &&
				(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
			) {
				return
			}
			e.preventDefault()
			setOpen(true)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [enabled])

	if (!enabled) return null

	return (
		<>
			<Button
				type="button"
				variant="default"
				size="sm"
				className="h-8 gap-1.5 px-3 text-xs font-semibold"
				onClick={() => setOpen(true)}
				aria-label={`Call ${agent.name}`}
			>
				<Phone size={14} aria-hidden="true" />
				Call {agent.name}
			</Button>
			<VoiceCallDialog agent={agent} open={open} onOpenChange={setOpen} />
		</>
	)
}
