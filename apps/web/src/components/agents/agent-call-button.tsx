import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { startVoiceCall } from '@/lib/voice-active-call'
import { VOICE_UNAVAILABLE_TOOLTIP, useVoiceUnavailable } from '@/lib/voice-availability'
import { Phone } from 'lucide-react'
import { useEffect } from 'react'

export function AgentCallButton({
	agent,
	variant = 'detail',
	shortcut = true,
}: {
	agent: VoiceCallAgent
	/** detail: the agent header's labelled button. row: the compact labelled
	 *  button on an agents-list row (hover-reveal on md+, inline below). icon:
	 *  the icon-only button in a chat thread header. composer: the round outline
	 *  icon button beside the mic in a message composer. */
	variant?: 'detail' | 'row' | 'icon' | 'composer'
	/** Whether V opens the dialog. Off for list rows, where many buttons share
	 *  one page and V has no single agent to mean. */
	shortcut?: boolean
}) {
	const unavailable = useVoiceUnavailable()

	// `V` starts the call when the agent detail is focused (anywhere on the
	// page counts, provided the user isn't typing in an input). Global scope
	// mirrors the SPEC: "V opens when the agent detail is focused."
	useEffect(() => {
		if (!shortcut || unavailable) return
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
			startVoiceCall(agent)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [shortcut, unavailable, agent])

	const button = (
		<Button
			type="button"
			variant={variant === 'composer' ? 'outline' : 'default'}
			size={variant === 'icon' || variant === 'composer' ? 'icon' : 'sm'}
			className={cn(
				// Reads as unavailable even when the row hover pushes opacity back to full.
				'disabled:bg-muted disabled:text-muted-foreground',
				variant === 'detail' && 'h-8 gap-1.5 px-3 text-xs font-semibold',
				// Hover-reveal only from md up: mobile has no hover, so below md the
				// button is always inline. Focus (keyboard, or a tap that lands on the
				// row) also reveals it, so it is never unreachable.
				variant === 'row' &&
					'mr-2 h-7 w-7 shrink-0 gap-1 px-0 text-xs font-semibold sm:mr-3 lg:w-auto lg:px-2.5 md:opacity-0 md:transition-opacity md:focus-visible:opacity-100 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100',
				variant === 'icon' &&
					'h-6 w-6 shrink-0 bg-brand text-brand-foreground hover:bg-brand-hover',
				variant === 'composer' && 'h-7 w-7 shrink-0 rounded-full text-muted-foreground',
			)}
			onClick={() => startVoiceCall(agent)}
			disabled={unavailable}
			aria-label={`Call ${agent.name}`}
		>
			<Phone size={variant === 'icon' ? 13 : 14} aria-hidden="true" />
			{variant === 'detail' && `Call ${agent.name}`}
			{variant === 'row' && <span className="hidden lg:inline">Call</span>}
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
			) : variant === 'icon' || variant === 'composer' ? (
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>{`Call ${agent.name} · V`}</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
		</>
	)
}
