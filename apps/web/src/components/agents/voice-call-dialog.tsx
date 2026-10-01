import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { type VoiceCall, type VoiceCallState, useVoiceCall } from '@/hooks/use-voice-call'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Mic, MicOff, PhoneOff, ScrollText, X } from 'lucide-react'
import { useEffect } from 'react'

// Verbatim strings — the SPEC's §Copy table is authoritative. A prototype
// string not listed there is a bug.
const COPY = {
	permissionBody:
		'Your microphone will only be used while this call is running. Transcript saves to this workspace.',
	permissionAllow: 'Allow microphone & start call',
	permissionCancel: 'Cancel',
	connectingBody: 'Establishing a WebRTC session (typically < 1s).',
	muted: 'Muted — agent still hears silence',
	reconnectingBody: 'Network dipped — retrying for 15s. The call auto-resumes if we get back.',
} as const

export function VoiceCallDialog({
	agent,
	open,
	onOpenChange,
}: {
	agent: ActorResponse
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const isMobile = useIsMobile()
	const call = useVoiceCall(agent.id, open)

	// Keyboard shortcuts inside the dialog: M toggles mute, T toggles the
	// transcript pane. Esc ends the call (handled natively by Radix' close on
	// escape, wired via `onOpenChange`). V is a page-scoped shortcut and lives
	// on the trigger side (AgentCallButton), not here.
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
				call.toggleMute()
			} else if (e.key.toLowerCase() === 't') {
				e.preventDefault()
				call.toggleTranscript()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, call])

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) call.end()
		onOpenChange(nextOpen)
	}

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
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogPortal>
				{/* Custom overlay — no dim on desktop; the 520px sheet sits alongside
				    chat rather than covering it per SPEC §Responsive. */}
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-transparent" />
				<DialogPrimitive.Content
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
	agent: ActorResponse
	call: VoiceCall
	onClose: () => void
	variant: 'mobile' | 'desktop'
}) {
	const { state, notice, transcriptOpen, start, toggleMute, toggleTranscript, end } = call
	const isLive = state.startsWith('live-') || state === 'reconnecting'
	const isMuted = state === 'live-muted'
	const isDesktop = variant === 'desktop'

	return (
		<div data-voice-call-state={state} className="flex h-full flex-col">
			{/* Tab order per SPEC: Mute → End → Transcript toggle → Transcript pane →
			    Close. Close renders LAST inside the DOM so a keyboard user cycling
			    through Tab reaches it after the primary controls. */}
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
					) : state === 'reconnecting' ? (
						<h2 className="text-lg font-semibold tracking-tight text-foreground">Reconnecting…</h2>
					) : (
						<h2 className="sr-only">Call with {agent.name}</h2>
					)}
				</DialogTitle>
			</div>

			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-6 pt-4">
				<AgentAvatar
					agent={agent}
					state={state}
					sizeClass={isDesktop ? 'size-28 text-3xl' : 'size-36 text-4xl'}
				/>

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

				{state === 'connecting' && (
					<>
						<p className="text-center text-sm text-muted-foreground">{COPY.connectingBody}</p>
						<Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
							{COPY.permissionCancel}
						</Button>
					</>
				)}

				{state === 'reconnecting' && (
					<>
						<p className="max-w-md text-center text-sm text-muted-foreground">
							{COPY.reconnectingBody}
						</p>
						<Button type="button" variant="outline" onClick={end} className="min-h-[44px]">
							Hang up
						</Button>
					</>
				)}

				{isLive && state !== 'reconnecting' && (
					<LiveStatusLabel state={state} agentName={agent.name} />
				)}
			</div>

			{isLive && (
				<>
					{isMuted && (
						<output className="mx-6 mb-3 block rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-center text-sm font-medium text-warning">
							{COPY.muted}
						</output>
					)}
					<div className="flex items-center justify-center gap-3 border-t border-border px-6 py-4">
						<CallControl
							ariaLabel={isMuted ? 'Unmute' : 'Mute'}
							onClick={toggleMute}
							variant={isMuted ? 'warning' : 'ghost'}
							size={variant === 'mobile' ? 'lg' : 'md'}
						>
							{isMuted ? <MicOff size={20} /> : <Mic size={20} />}
						</CallControl>
						<CallControl
							ariaLabel="End call"
							onClick={end}
							variant="danger"
							size={variant === 'mobile' ? 'xl' : 'lg'}
						>
							<PhoneOff size={20} />
						</CallControl>
						<CallControl
							ariaLabel={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
							onClick={toggleTranscript}
							variant="ghost"
							size={variant === 'mobile' ? 'lg' : 'md'}
							aria-pressed={transcriptOpen}
						>
							<ScrollText size={20} />
						</CallControl>
					</div>
					{transcriptOpen && (
						<div
							aria-live="polite"
							aria-atomic="false"
							className="max-h-48 overflow-y-auto border-t border-border bg-muted/30 px-6 py-4 text-sm text-muted-foreground"
						>
							{/* Task 3 wires the live transcript. Placeholder line keeps the
							    pane self-explaining and gives screen readers something to
							    announce when it opens. */}
							Transcript will appear here as you talk. Persistence lands in Task 3.
						</div>
					)}
				</>
			)}

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

function AgentAvatar({
	agent,
	state,
	sizeClass,
}: {
	agent: ActorResponse
	state: VoiceCallState
	/** Tailwind size utility overriding ActorAvatar's own xl (52px). SPEC
	 *  wants 112 desktop / 140 mobile — tailwind-merge lets us swap the size
	 *  via className without a new ActorAvatar step. */
	sizeClass: string
}) {
	// Ring animation is paused at 300° in agent-thinking, user-speaking, and
	// muted states — a static arc in each, so the ring stays a "connection is
	// live" tell without pretending the agent is the one talking. Reconnecting
	// omits the ring entirely (the ring means "we're connected"; a paused ring
	// wouldn't).
	const wearsRing = state !== 'permission' && state !== 'reconnecting'
	const wearsBreathing = state === 'live-agent-speaking'
	const ringPaused =
		state === 'live-agent-thinking' || state === 'live-user-speaking' || state === 'live-muted'

	return (
		<div
			className={cn(
				'relative flex items-center justify-center rounded-full',
				wearsRing && !ringPaused && 'speaking-ring',
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

function LiveStatusLabel({ state, agentName }: { state: VoiceCallState; agentName: string }) {
	if (state === 'live-user-speaking') {
		return (
			<div className="flex items-center gap-2 text-sm font-medium text-foreground">
				<Bars />
				<span>Listening…</span>
			</div>
		)
	}
	if (state === 'live-agent-thinking') {
		return (
			<div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
				<span>{agentName} is thinking…</span>
			</div>
		)
	}
	// live-agent-speaking and live-muted both label as "<agent> is speaking",
	// with the muted state getting the standalone banner above the controls.
	return (
		<div className="text-sm font-medium text-foreground">
			{agentName} {state === 'live-muted' ? 'is speaking' : 'is speaking'}
		</div>
	)
}

function Bars() {
	// The five staggered bars from app.css's `.voice-bars`. Purely decorative;
	// the label next to it is the a11y-load-bearing piece.
	return (
		<span className="voice-bars text-brand" aria-hidden="true">
			<span />
			<span />
			<span />
			<span />
			<span />
		</span>
	)
}

function CallControl({
	ariaLabel,
	onClick,
	variant,
	size,
	children,
	...rest
}: {
	ariaLabel: string
	onClick: () => void
	variant: 'ghost' | 'danger' | 'warning'
	size: 'md' | 'lg' | 'xl'
	children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'aria-label'>) {
	const sizeClasses = {
		md: 'h-12 w-12',
		lg: 'h-14 w-14',
		xl: 'h-16 w-16',
	}[size]
	const variantClasses = {
		ghost: 'bg-muted text-foreground hover:bg-muted/80',
		warning: 'bg-warning/15 text-warning hover:bg-warning/25',
		danger: 'bg-error text-white hover:bg-error/90',
	}[variant]

	return (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={onClick}
			className={cn(
				'inline-flex items-center justify-center rounded-full ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
				sizeClasses,
				variantClasses,
			)}
			{...rest}
		>
			{children}
		</button>
	)
}

function ariaLiveMessageFor(state: VoiceCallState, agentName: string): string {
	switch (state) {
		case 'permission':
			return `Voice call with ${agentName} awaiting microphone permission.`
		case 'connecting':
			return `Connecting to ${agentName}.`
		case 'live-agent-speaking':
		case 'live-agent-thinking':
		case 'live-muted':
			return `${agentName} is speaking.`
		case 'live-user-speaking':
			return 'Listening.'
		case 'reconnecting':
			return 'Reconnecting.'
	}
}
