import { type VoiceCallAgent, VoiceCallDialog } from '@/components/agents/voice-call-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { cn } from '@/lib/cn'
import { VOICE_UNAVAILABLE_TOOLTIP, useVoiceUnavailable } from '@/lib/voice-availability'
import { Phone } from 'lucide-react'
import { useEffect, useState } from 'react'

// One boundary per feature — this component reads `voice-mode-v1` and renders
// nothing when the flag is off, so every surface that mounts it (agent detail
// header, agent rows, thread header) stays trivial and the flag is not
// scattered across per-element checks. When the flag is deleted (feature ships
// to everyone), this component's guard is the only site to clean up.
const VOICE_MODE_V1_ID = 'voice-mode-v1'

export function AgentCallButton({
	agent,
	variant = 'detail',
	shortcut = true,
}: {
	agent: VoiceCallAgent
	/** detail: the agent header's labelled button. row: the compact labelled
	 *  button on an agents-list row (hover-reveal on md+, inline below). icon:
	 *  the icon-only button in a chat thread header. */
	variant?: 'detail' | 'row' | 'icon'
	/** Whether V opens the dialog. Off for list rows, where many buttons share
	 *  one page and V has no single agent to mean. */
	shortcut?: boolean
}) {
	const enabled = useFeatureFlag(VOICE_MODE_V1_ID)
	const unavailable = useVoiceUnavailable()
	const [open, setOpen] = useState(false)

	// `V` opens the dialog when the agent detail is focused (anywhere on the
	// page counts, provided the user isn't typing in an input). Global scope
	// mirrors the SPEC: "V opens when the agent detail is focused."
	useEffect(() => {
		if (!enabled || !shortcut || unavailable) return
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
	}, [enabled, shortcut, unavailable])

	if (!enabled) return null

	const button = (
		<Button
			type="button"
			variant="default"
			size={variant === 'icon' ? 'icon' : 'sm'}
			className={cn(
				// Reads as unavailable even when the row hover pushes opacity back to full.
				'disabled:bg-muted disabled:text-muted-foreground',
				variant === 'detail' && 'h-8 gap-1.5 px-3 text-xs font-semibold',
				// Hover-reveal only from md up: mobile has no hover, so below md the
				// button is always inline. Focus (keyboard, or a tap that lands on the
				// row) also reveals it, so it is never unreachable.
				variant === 'row' &&
					'mr-2 h-7 w-7 shrink-0 gap-1 px-0 text-xs font-semibold sm:mr-3 sm:w-auto sm:px-2.5 md:opacity-0 md:transition-opacity md:focus-visible:opacity-100 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100',
				variant === 'icon' &&
					'h-6 w-6 shrink-0 bg-brand text-brand-foreground hover:bg-brand-hover',
			)}
			onClick={() => setOpen(true)}
			disabled={unavailable}
			aria-label={`Call ${agent.name}`}
		>
			<Phone size={variant === 'icon' ? 13 : 14} aria-hidden="true" />
			{variant === 'detail' && `Call ${agent.name}`}
			{variant === 'row' && <span className="hidden sm:inline">Call</span>}
		</Button>
	)

	return (
		<>
			{unavailable ? (
				// A disabled button swallows pointer events, so the tooltip hangs off
				// a focusable wrapper instead.
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex">{button}</span>
					</TooltipTrigger>
					<TooltipContent>{VOICE_UNAVAILABLE_TOOLTIP}</TooltipContent>
				</Tooltip>
			) : variant === 'icon' ? (
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>{`Call ${agent.name} · V`}</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
			<VoiceCallDialog agent={agent} open={open} onOpenChange={setOpen} />
		</>
	)
}
