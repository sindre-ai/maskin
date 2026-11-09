import type { VoiceCallAgent } from '@/components/agents/voice-call-dialog'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCanWrite } from '@/hooks/use-can-write'
import { cn } from '@/lib/cn'
import { startVoiceCall } from '@/lib/voice-active-call'
import { VOICE_UNAVAILABLE_TOOLTIP, useVoiceUnavailable } from '@/lib/voice-availability'
import { AudioLines, Phone } from 'lucide-react'
import { useEffect } from 'react'

export function AgentCallButton({
	agent,
	variant = 'detail',
	shortcut = true,
	label,
	secondary = false,
	tooltip,
}: {
	agent: VoiceCallAgent
	/** detail: the agent header's labelled button. row: the compact labelled
	 *  button on an agents-list row (hover-reveal on md+, inline below). icon:
	 *  the icon-only button in a chat thread header. composer: the round outline
	 *  icon button beside the mic in a message composer. */
	variant?: 'detail' | 'row' | 'icon' | 'composer' | 'thread'
	/** Whether V opens the dialog. Off for list rows, where many buttons share
	 *  one page and V has no single agent to mean. */
	shortcut?: boolean
	/** Visible text of the `detail` variant; the accessible name stays "Call <agent>".
	 *  The agent page's top bar says just "Live". */
	label?: string
	/** Draws the `detail` variant as the quieter button beside a primary one. */
	secondary?: boolean
	/** Tooltip of the `thread` variant (the round icon), e.g. "Talk live with this chat". */
	tooltip?: string
}) {
	const unavailable = useVoiceUnavailable()
	// Starting a call reserves a voice session, which a viewer cannot do.
	const canWrite = useCanWrite()

	// `V` starts the call when the agent detail is focused (anywhere on the
	// page counts, provided the user isn't typing in an input). Global scope
	// mirrors the SPEC: "V opens when the agent detail is focused."
	useEffect(() => {
		if (!shortcut || unavailable || !canWrite) return
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
	}, [shortcut, unavailable, canWrite, agent])

	const button = (
		<Button
			type="button"
			variant={
				variant === 'composer' ||
				variant === 'thread' ||
				variant === 'row' ||
				(variant === 'detail' && secondary)
					? 'outline'
					: variant === 'icon'
						? 'ghost'
						: 'default'
			}
			size={variant === 'icon' || variant === 'composer' || variant === 'thread' ? 'icon' : 'sm'}
			className={cn(
				// Reads as unavailable even when the row hover pushes opacity back to full.
				'disabled:bg-muted disabled:text-muted-foreground',
				variant === 'detail' &&
					(secondary
						? 'h-8 gap-1.5 rounded-full px-3.5 text-[13px] font-semibold'
						: 'h-8 gap-1.5 px-3 text-xs font-semibold'),
				// Hover-reveal only from md up: mobile has no hover, so below md the
				// button is always inline. Focus (keyboard, or a tap that lands on the
				// row) also reveals it, so it is never unreachable.
				// v16: an outlined pill with the word Call, always visible (no hover reveal).
				variant === 'row' && 'h-[30px] w-16 shrink-0 rounded-full px-0 text-[13px] font-semibold',
				// Plain ghost icon like Copy, Pin and Archive beside it. Disabled drops
				// the muted plate so it dims instead of showing a grey square.
				variant === 'icon' &&
					'h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground disabled:bg-transparent',
				variant === 'composer' && 'h-7 w-7 shrink-0 rounded-full text-muted-foreground',
				// v3 thread header: a 32px round outline icon beside the ··· and panel buttons.
				variant === 'thread' && 'size-8 shrink-0 rounded-full',
			)}
			onClick={() => startVoiceCall(agent)}
			disabled={unavailable || !canWrite}
			aria-label={`Call ${agent.name}`}
		>
			{variant === 'thread' ? (
				<AudioLines size={16} aria-hidden="true" />
			) : variant === 'detail' && (secondary || label === 'Live') ? (
				<AudioLines size={14} aria-hidden="true" />
			) : (
				variant !== 'row' && <Phone size={variant === 'icon' ? 13 : 14} aria-hidden="true" />
			)}
			{variant === 'detail' && (label ?? `Call ${agent.name}`)}
			{variant === 'row' && 'Call'}
		</Button>
	)

	if (!canWrite) {
		// The composer variant already sits under the composer's own viewer tooltip.
		return variant === 'composer' ? button : <ViewerTooltip>{button}</ViewerTooltip>
	}

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
			) : variant === 'icon' || variant === 'composer' || variant === 'thread' ? (
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>
						{variant === 'thread' ? (tooltip ?? 'Talk live') : `Call ${agent.name} · V`}
					</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
		</>
	)
}
