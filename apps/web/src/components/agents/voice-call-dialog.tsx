import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { type VoiceCall, type VoiceCallState, useVoiceCall } from '@/hooks/use-voice-call'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
import { publishVoiceCallView } from '@/lib/voice-call-view'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ExternalLink, MicOff, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

/** The slice of an actor the call dialog needs; agent rows pass list items, the detail header passes the full record. */
export type VoiceCallAgent = Pick<ActorResponse, 'id' | 'name' | 'type'>

// Verbatim strings — the SPEC's §Copy table is authoritative. A prototype
// string not listed there is a bug.
const COPY = {
	permissionBody:
		'Your microphone will only be used while this call is running. Transcript saves to this workspace.',
	permissionAllow: 'Allow microphone & start call',
	permissionCancel: 'Cancel',
	connectingBody: 'Starting the call…',
	micBlockedTitle: 'Microphone blocked',
	micBlockedBody: "Enable microphone access in your browser's site settings, then try again.",
	micBlockedAction: 'How to enable →',
	noMicTitle: 'No microphone found',
	noMicBody:
		'Connect a microphone (or check that headphones with a mic are plugged in), then try again.',
	noMicAction: 'Retry',
} as const

// External help page for the Mic-blocked state's "How to enable →" link.
const MIC_HELP_URL = 'https://support.google.com/chrome/answer/2693767'

export function VoiceCallDialog({
	agent,
	open,
	onOpenChange,
}: {
	agent: VoiceCallAgent
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const isMobile = useIsMobile()
	const call = useVoiceCall(agent.id, agent.name, open)
	const { setOpen: setPaletteOpen } = useCommandPalette()
	const { state, speakerOn, transcriptLines, toggleMute, toggleSpeaker } = call
	const isLive = state.startsWith('live-') || state === 'reconnecting'
	// Once the call is live it leaves this dialog: the panel, the bar and the
	// header capsule (live-call-surface.tsx) are drawn from the view published
	// here. The call itself, mic and connection included, stays owned by this
	// component, which is why it keeps rendering (as nothing) while live.
	const [liveSince, setLiveSince] = useState<number | null>(null)
	const [minimized, setMinimized] = useState(false)
	const [captionsOn, setCaptionsOn] = useState(true)

	useEffect(() => {
		if (isLive) setLiveSince((prev) => prev ?? Date.now())
	}, [isLive])

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) call.end()
		onOpenChange(nextOpen)
	}

	const caption = useMemo(() => {
		for (let i = transcriptLines.length - 1; i >= 0; i--) {
			const line = transcriptLines[i]
			if (line?.kind === 'assistant') return line.text
		}
		return null
	}, [transcriptLines])

	// biome-ignore lint/correctness/useExhaustiveDependencies: handleOpenChange only closes over call.end and onOpenChange
	useEffect(() => {
		if (!isLive || liveSince === null) {
			publishVoiceCallView(null)
			return
		}
		publishVoiceCallView({
			agent,
			state,
			liveSince,
			caption,
			captionsOn,
			speakerOn,
			minimized,
			toggleMute,
			toggleSpeaker,
			toggleCaptions: () => setCaptionsOn((v) => !v),
			setMinimized,
			pullUp: () => {
				setMinimized(true)
				setPaletteOpen(true)
			},
			end: () => handleOpenChange(false),
		})
	}, [
		isLive,
		liveSince,
		agent,
		state,
		caption,
		captionsOn,
		speakerOn,
		minimized,
		toggleMute,
		toggleSpeaker,
		setPaletteOpen,
		onOpenChange,
	])
	useEffect(() => () => publishVoiceCallView(null), [])

	// Keyboard shortcut inside the dialog: M toggles mute. Esc ends the call
	// (handled natively by Radix' close on escape, wired via `onOpenChange`). V
	// is a page-scoped shortcut and lives on the trigger side (AgentCallButton).
	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return
			const target = e.target as HTMLElement | null
			if (
				target &&
				(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
			) {
				return
			}
			if (e.key.toLowerCase() === 'm') {
				e.preventDefault()
				toggleMute()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, toggleMute])

	if (isLive) return null

	// Mobile is a fullscreen sheet; desktop / tablet is a right-anchored 520px
	// dialog. Everything below the shell is the same — same state, same tab
	// order, same controls, same copy. Only the outer surface swaps.
	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={handleOpenChange}>
				<SheetContent
					side="bottom"
					hideCloseButton
					className="inset-0 flex h-full max-h-none w-full max-w-none flex-col rounded-none border-none bg-background p-0"
					aria-label={`Call ${agent.name}`}
				>
					<VoiceCallDialogBody
						agent={agent}
						call={call}
						onClose={() => handleOpenChange(false)}
						variant="mobile"
					/>
				</SheetContent>
			</Sheet>
		)
	}

	return (
		// Non-modal: the call lives in the workspace layout and follows the user
		// across pages, so the page behind it must stay clickable. That means no
		// overlay, and a click or focus move outside must not end the call (only
		// the End/Close controls and Esc do).
		<Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
			<DialogPortal>
				<DialogPrimitive.Content
					onInteractOutside={(e) => e.preventDefault()}
					aria-label={`Call ${agent.name}`}
					className="fixed inset-y-4 right-4 z-50 flex w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background p-0 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
				>
					<VoiceCallDialogBody
						agent={agent}
						call={call}
						onClose={() => handleOpenChange(false)}
						variant="desktop"
					/>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	)
}

function VoiceCallDialogBody({
	agent,
	call,
	onClose,
	variant,
}: {
	agent: VoiceCallAgent
	call: VoiceCall
	onClose: () => void
	variant: 'mobile' | 'desktop'
}) {
	const { state, notice, start, retryMic } = call
	const isDesktop = variant === 'desktop'
	const isMicError = state === 'mic-blocked' || state === 'no-mic'

	return (
		<div data-voice-call-state={state} className="flex h-full flex-col">
			{/* Close renders LAST inside the DOM so a keyboard user cycling through
			    Tab reaches it after the primary controls. */}
			<div className="flex items-start justify-between px-6 pt-6">
				<DialogTitle asChild>
					{state === 'permission' ? (
						<h2 className="text-lg font-semibold tracking-tight text-foreground">
							Call {agent.name}
						</h2>
					) : state === 'connecting' ? (
						<h2 className="text-lg font-semibold tracking-tight text-foreground">
							Connecting to {agent.name}…
						</h2>
					) : state === 'mic-blocked' ? (
						<h2 className="text-lg font-semibold tracking-tight text-foreground">
							{COPY.micBlockedTitle}
						</h2>
					) : state === 'no-mic' ? (
						<h2 className="text-lg font-semibold tracking-tight text-foreground">
							{COPY.noMicTitle}
						</h2>
					) : (
						<h2 className="sr-only">Call with {agent.name}</h2>
					)}
				</DialogTitle>
			</div>

			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-6 pt-4">
				{isMicError ? (
					// Error states swap the avatar for a status circle: red for a
					// blocked mic (the user can fix it), muted for no device. No motion
					// in either, so prefers-reduced-motion has nothing to opt out of.
					<div
						aria-hidden="true"
						className={cn(
							'flex items-center justify-center rounded-full',
							isDesktop ? 'size-28' : 'size-36',
							state === 'mic-blocked' ? 'bg-error/10 text-error' : 'bg-muted text-muted-foreground',
						)}
					>
						<MicOff size={isDesktop ? 44 : 56} />
					</div>
				) : (
					<AgentAvatar
						agent={agent}
						state={state}
						sizeClass={isDesktop ? 'size-28 text-3xl' : 'size-36 text-4xl'}
					/>
				)}

				{/* aria-live=polite region — announces state transitions to screen
				    readers without stealing focus. Rendered here so it's present in
				    the DOM from the first paint. */}
				<div aria-live="polite" className="sr-only">
					{ariaLiveMessageFor(state, agent.name)}
				</div>

				{state === 'permission' && (
					<>
						<p className="max-w-md text-center text-sm text-muted-foreground">
							{COPY.permissionBody}
						</p>
						{notice && (
							<output className="block max-w-md text-center text-sm text-error">{notice}</output>
						)}
						<div className="flex flex-col items-stretch gap-2 sm:flex-row">
							<Button type="button" onClick={start} className="min-h-[44px]">
								{COPY.permissionAllow}
							</Button>
							<Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
								{COPY.permissionCancel}
							</Button>
						</div>
					</>
				)}

				{state === 'mic-blocked' && (
					<>
						<p className="max-w-md text-center text-sm text-muted-foreground">
							{COPY.micBlockedBody}
						</p>
						<div className="flex flex-col items-stretch gap-2 sm:flex-row">
							<Button asChild className="min-h-[44px]">
								<a href={MIC_HELP_URL} target="_blank" rel="noopener noreferrer">
									{COPY.micBlockedAction}
									<ExternalLink aria-hidden="true" />
								</a>
							</Button>
							<Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
								{COPY.permissionCancel}
							</Button>
						</div>
					</>
				)}

				{state === 'no-mic' && (
					<>
						<p className="max-w-md text-center text-sm text-muted-foreground">{COPY.noMicBody}</p>
						<div className="flex flex-col items-stretch gap-2 sm:flex-row">
							<Button type="button" onClick={retryMic} className="min-h-[44px]">
								{COPY.noMicAction}
							</Button>
							<Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
								{COPY.permissionCancel}
							</Button>
						</div>
					</>
				)}

				{state === 'connecting' && (
					<>
						<p className="text-center text-sm text-muted-foreground">{COPY.connectingBody}</p>
						<Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
							{COPY.permissionCancel}
						</Button>
					</>
				)}
			</div>

			{/* Close is the last tabbable element, per SPEC tab order. */}
			<button
				type="button"
				onClick={onClose}
				aria-label="Close call"
				className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground ring-offset-background transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<X size={16} />
			</button>
		</div>
	)
}

export function AgentAvatar({
	agent,
	state,
	sizeClass,
}: {
	agent: VoiceCallAgent
	state: VoiceCallState
	/** Tailwind size utility overriding ActorAvatar's own xl (52px). SPEC
	 *  wants 112 desktop / 140 mobile — tailwind-merge lets us swap the size
	 *  via className without a new ActorAvatar step. */
	sizeClass: string
}) {
	// Ring animation is paused at 300° in agent-thinking, user-speaking, and
	// muted states — a static arc in each, so the ring stays a "connection is
	// live" tell without pretending the agent is the one talking. User-speaking
	// also fades it (SPEC: reduced-opacity ring). Reconnecting omits the ring
	// entirely (the ring means "we're connected"; a paused ring wouldn't).
	const wearsRing = state !== 'permission' && state !== 'reconnecting'
	const wearsBreathing = state === 'live-agent-speaking'
	const ringPaused =
		state === 'live-agent-thinking' || state === 'live-user-speaking' || state === 'live-muted'

	return (
		<div
			className={cn(
				'relative flex items-center justify-center rounded-full',
				wearsRing && 'speaking-ring',
				wearsRing && ringPaused && 'speaking-ring-paused',
				state === 'live-user-speaking' && 'speaking-ring-faded',
				wearsBreathing && 'voice-level',
			)}
			aria-hidden="true"
		>
			<ActorAvatar
				name={agent.name}
				type={agent.type}
				size="xl"
				tone="strong"
				id={agent.id}
				className={cn('rounded-full font-bold', sizeClass)}
			/>
		</div>
	)
}

function ariaLiveMessageFor(state: VoiceCallState, agentName: string): string {
	switch (state) {
		case 'permission':
			return `Voice call with ${agentName} awaiting microphone permission.`
		case 'mic-blocked':
			return 'Microphone blocked.'
		case 'no-mic':
			return 'No microphone found.'
		case 'connecting':
			return `Connecting to ${agentName}.`
		default:
			return `Call with ${agentName} is live.`
	}
}
