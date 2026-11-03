/**
 * The live call, drawn where the page has room: a right-hand panel while it is
 * expanded, a dock above the composer on narrow screens, and a bar once it is
 * minimised. Exactly one of them at a time. They all read the view the
 * call's owner (VoiceCallDialog) publishes; none of them owns the call.
 */

import { AgentAvatar } from '@/components/agents/voice-call-dialog'
import { Button } from '@/components/ui/button'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/cn'
import {
	type VoiceCallView,
	setVoiceCallComposerSlot,
	useVoiceCallComposerSlot,
	useVoiceCallView,
	voiceCallStatus,
} from '@/lib/voice-call-view'
import { formatCallClock } from '@/lib/voice-receipts'
import {
	Captions,
	ChevronDown,
	Mic,
	MicOff,
	PhoneOff,
	Search,
	Volume2,
	VolumeX,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Set by the minimise button so the bar that replaces the panel takes focus;
// without it focus falls to the page body when the button unmounts. Not set by
// anything that remounts the bar (navigating between a thread and another page).
let focusBarNext = false

/** Seconds since `liveSince`, ticking every second. */
function useElapsed(liveSince: number): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [])
	return Math.max(0, Math.floor((now - liveSince) / 1000))
}

function Bars({ active }: { active: boolean }) {
	return (
		<span className={cn('voice-bars text-brand', !active && 'opacity-40')} aria-hidden="true">
			{[0, 1, 2, 3, 4].map((i) => (
				<span key={i} style={active ? undefined : { animation: 'none', height: '30%' }} />
			))}
		</span>
	)
}

function RoundButton({
	label,
	onClick,
	pressed,
	danger,
	size = 'md',
	children,
}: {
	label: string
	onClick: () => void
	pressed?: boolean
	danger?: boolean
	size?: 'sm' | 'md'
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={cn(
				'inline-flex shrink-0 items-center justify-center rounded-full ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
				size === 'md' ? 'size-11' : 'size-9',
				danger
					? 'bg-error text-white hover:bg-error/90'
					: pressed
						? 'bg-warning/15 text-warning hover:bg-warning/25'
						: 'bg-muted text-foreground hover:bg-muted/80',
			)}
		>
			{children}
		</button>
	)
}

/** The header capsule: green dot and the running time. */
export function LiveCapsule({ className }: { className?: string }) {
	const view = useVoiceCallView()
	if (!view) return null
	return <LiveCapsuleInner view={view} className={className} />
}

function LiveCapsuleInner({ view, className }: { view: VoiceCallView; className?: string }) {
	const elapsed = useElapsed(view.liveSince)
	// The clock changes every second, so it is hidden from assistive tech; the
	// label states the time in whole minutes and so changes once a minute.
	const minutes = Math.floor(elapsed / 60)
	const label = `Live call with ${view.agent.name}, ${
		minutes === 0 ? 'under a minute' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
	}`
	return (
		<span
			role="timer"
			aria-live="off"
			aria-label={label}
			className={cn(
				'inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-brand-subtle px-3 font-mono text-[13px] font-semibold text-brand-subtle-foreground md:h-9',
				className,
			)}
		>
			<span aria-hidden="true" className="size-2 rounded-full bg-brand" />
			<span aria-hidden="true">{formatCallClock(elapsed)}</span>
		</span>
	)
}

function Controls({ view }: { view: VoiceCallView }) {
	const muted = view.state === 'live-muted'
	const items: {
		label: string
		node: ReactNode
		onClick: () => void
		pressed?: boolean
		danger?: boolean
	}[] = [
		{
			label: muted ? 'Unmute' : 'Mute',
			node: muted ? <MicOff size={18} /> : <Mic size={18} />,
			onClick: view.toggleMute,
			pressed: muted,
		},
		{
			label: view.speakerOn ? 'Speaker off' : 'Speaker on',
			node: view.speakerOn ? <Volume2 size={18} /> : <VolumeX size={18} />,
			onClick: view.toggleSpeaker,
			pressed: !view.speakerOn,
		},
		{
			label: view.captionsOn ? 'Hide captions' : 'Show captions',
			node: <Captions size={18} />,
			onClick: view.toggleCaptions,
			pressed: false,
		},
		{ label: 'Pull up', node: <Search size={18} />, onClick: view.pullUp },
		{ label: 'End call', node: <PhoneOff size={18} />, onClick: view.end, danger: true },
	]
	const visible: Record<string, string> = {
		Mute: 'Mic',
		Unmute: 'Mic',
		'Speaker off': 'Speaker',
		'Speaker on': 'Speaker',
		'Hide captions': 'Captions',
		'Show captions': 'Captions',
		'Pull up': 'Pull up',
		'End call': 'End',
	}
	return (
		<div className="flex items-start justify-between gap-1 px-3 pb-3 pt-2">
			{items.map((item) => (
				<div key={visible[item.label]} className="flex min-w-0 flex-1 flex-col items-center gap-1">
					<RoundButton
						label={item.label}
						onClick={item.onClick}
						pressed={item.pressed}
						danger={item.danger}
					>
						{item.node}
					</RoundButton>
					<span aria-hidden="true" className="text-[11px] text-muted-foreground">
						{visible[item.label]}
					</span>
				</div>
			))}
		</div>
	)
}

function Caption({ view }: { view: VoiceCallView }) {
	if (!view.captionsOn) return null
	return (
		<p className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
			{view.caption ?? `Captions appear here when ${view.agent.name} speaks.`}
		</p>
	)
}

/** What the status line alone does not explain: a dropped connection, a muted mic. */
function Notice({ view }: { view: VoiceCallView }) {
	const text =
		view.state === 'reconnecting'
			? 'Network dipped, retrying for 15s. The call auto-resumes if we get back.'
			: view.state === 'live-muted'
				? 'Muted. The agent still hears silence.'
				: null
	if (!text) return null
	return (
		<output
			className={cn(
				'block rounded-md border px-3 py-2 text-center text-sm font-medium',
				view.state === 'reconnecting'
					? 'border-border bg-muted text-muted-foreground'
					: 'border-warning/40 bg-warning/10 text-warning',
			)}
		>
			{text}
		</output>
	)
}

/** The expanded call: a right-hand column (`panel`) or a card above the composer (`dock`). */
function LiveCallPanel({ view, layout }: { view: VoiceCallView; layout: 'panel' | 'dock' }) {
	const elapsed = useElapsed(view.liveSince)
	const speaking = view.state === 'live-agent-speaking'
	const status = voiceCallStatus(view.state)
	const collapse = (
		<button
			type="button"
			aria-label="Minimise call"
			onClick={() => {
				focusBarNext = true
				view.setMinimized(true)
			}}
			className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<ChevronDown size={18} />
		</button>
	)

	if (layout === 'dock') {
		return (
			<section
				aria-label={`Call with ${view.agent.name}`}
				data-voice-call-surface="dock"
				className="flex flex-col gap-2 rounded-3xl border border-border bg-card pt-3 shadow-md max-[479px]:rounded-2xl"
			>
				<div className="flex items-center gap-3 px-3.5">
					<AgentAvatar agent={view.agent} state={view.state} sizeClass="size-12 text-lg" />
					<div className="min-w-0 flex-1">
						<p className="truncate text-[17px] font-bold text-foreground">{view.agent.name}</p>
						<p aria-live="polite" className="truncate text-sm text-muted-foreground">
							{status}
						</p>
					</div>
					<Bars active={speaking} />
					<span className="font-mono text-sm font-semibold text-foreground">
						{formatCallClock(elapsed)}
					</span>
					{collapse}
				</div>
				<div className="flex flex-col gap-2 px-3.5">
					<Notice view={view} />
					<Caption view={view} />
				</div>
				<Controls view={view} />
			</section>
		)
	}

	return (
		// `dark` re-resolves the semantic tokens inside the panel: the call is the
		// one surface drawn on a dark stage in both themes (v3 live call).
		<aside
			aria-label={`Call with ${view.agent.name}`}
			data-voice-call-surface="panel"
			className="dark relative flex w-[300px] shrink-0 flex-col border-l border-border bg-background text-foreground lg:w-[340px]"
		>
			<div className="absolute right-3 top-3">{collapse}</div>
			<div className="flex flex-col items-center gap-0.5 px-12 pt-8 text-center">
				<p className="truncate text-base font-bold">{view.agent.name}</p>
				<span className="font-mono text-xs text-muted-foreground">{formatCallClock(elapsed)}</span>
			</div>
			<div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-6">
				<Orb speaking={speaking} thinking={view.state === 'live-agent-thinking'} />
				<p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
					<Bars active={speaking} />
					{status}
				</p>
				<div className="flex w-full flex-col gap-2">
					<Notice view={view} />
				</div>
			</div>
			<div className="flex flex-col items-center gap-4 px-4 pb-6">
				{view.captionsOn && (
					<p
						className={cn(
							'text-center',
							view.caption
								? 'text-xl font-bold text-foreground'
								: 'text-base text-muted-foreground',
						)}
					>
						{view.caption ?? `Captions appear here when ${view.agent.name} speaks.`}
					</p>
				)}
				<PanelControls view={view} />
			</div>
		</aside>
	)
}

/** The call's orb: a glowing sphere, with two pulsing rings while the agent speaks. */
function Orb({ speaking, thinking }: { speaking: boolean; thinking: boolean }) {
	return (
		<div className="relative flex size-40 items-center justify-center" aria-hidden="true">
			{speaking && (
				<>
					<span className="absolute inset-0 rounded-full border border-brand/50 motion-safe:animate-ping" />
					<span className="absolute inset-0 rounded-full border border-brand/30 motion-safe:animate-ping [animation-delay:1.2s]" />
				</>
			)}
			<span
				className={cn(
					'size-40 rounded-full bg-[radial-gradient(circle_at_30%_28%,color-mix(in_oklab,var(--brand)_35%,white),var(--brand)_62%)] shadow-[0_0_80px_color-mix(in_oklab,var(--brand)_45%,transparent)]',
					thinking && 'motion-safe:animate-pulse',
				)}
			/>
		</div>
	)
}

/** Mute and End are the two calls to action; the rest sit quietly above them. */
function PanelControls({ view }: { view: VoiceCallView }) {
	const muted = view.state === 'live-muted'
	const quiet = [
		{
			label: view.speakerOn ? 'Speaker off' : 'Speaker on',
			node: view.speakerOn ? <Volume2 size={16} /> : <VolumeX size={16} />,
			onClick: view.toggleSpeaker,
			pressed: !view.speakerOn,
		},
		{
			label: view.captionsOn ? 'Hide captions' : 'Show captions',
			node: <Captions size={16} />,
			onClick: view.toggleCaptions,
			pressed: false,
		},
		{ label: 'Pull up', node: <Search size={16} />, onClick: view.pullUp, pressed: undefined },
	]
	return (
		<div className="flex flex-col items-center gap-3">
			<div className="flex items-center gap-1">
				{quiet.map((item) => (
					<button
						key={item.label}
						type="button"
						aria-label={item.label}
						aria-pressed={item.pressed}
						title={item.label}
						onClick={item.onClick}
						className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-warning"
					>
						{item.node}
					</button>
				))}
			</div>
			<div className="flex items-center gap-3">
				<Button
					type="button"
					variant="secondary"
					aria-label={muted ? 'Unmute' : 'Mute'}
					aria-pressed={muted}
					onClick={view.toggleMute}
					className="h-11 rounded-full px-6 text-base font-semibold"
				>
					{muted ? 'Unmute' : 'Mute'}
				</Button>
				<Button
					type="button"
					aria-label="End call"
					onClick={view.end}
					className="h-11 rounded-full px-6 text-base font-semibold"
				>
					End
				</Button>
			</div>
		</div>
	)
}

/** The minimised call: a 56px pill that follows the person across pages. */
function LiveCallBar({ view, floating }: { view: VoiceCallView; floating: boolean }) {
	const elapsed = useElapsed(view.liveSince)
	const muted = view.state === 'live-muted'
	const expandRef = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (!focusBarNext) return
		focusBarNext = false
		expandRef.current?.focus()
	}, [])
	return (
		<section
			aria-label={`Call with ${view.agent.name}`}
			data-voice-call-surface="bar"
			className={cn(
				'flex h-14 items-center gap-3 rounded-full border border-border bg-card pl-4 pr-2 shadow-md',
				floating && 'fixed bottom-4 right-4 z-50 w-[340px] max-w-[calc(100vw-2rem)]',
			)}
		>
			<Bars active={view.state === 'live-agent-speaking'} />
			<button
				ref={expandRef}
				type="button"
				aria-label="Expand call"
				onClick={() => view.setMinimized(false)}
				className="flex min-w-0 flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="truncate text-[15px] font-bold leading-tight text-foreground">
					Live · {view.agent.name}
				</span>
				<span
					aria-live="polite"
					className="truncate text-[13px] leading-tight text-muted-foreground"
				>
					{voiceCallStatus(view.state)}
				</span>
			</button>
			<span className="font-mono text-sm font-semibold text-foreground">
				{formatCallClock(elapsed)}
			</span>
			<RoundButton
				label={muted ? 'Unmute' : 'Mute'}
				onClick={view.toggleMute}
				pressed={muted}
				size="sm"
			>
				{muted ? <MicOff size={16} /> : <Mic size={16} />}
			</RoundButton>
			<RoundButton label="End call" onClick={view.end} danger size="sm">
				<PhoneOff size={16} />
			</RoundButton>
		</section>
	)
}

/**
 * The marker above a thread's composer. The dock and the bar render into it so
 * they sit between the messages and the input, and take the chat's width.
 */
export function LiveCallComposerSlot() {
	return <div ref={setVoiceCallComposerSlot} className="empty:hidden" />
}

/** Mounted once, as a flex sibling of the page, so the panel takes a column. */
export function LiveCallSurface() {
	const view = useVoiceCallView()
	const slot = useVoiceCallComposerSlot()
	const wide = useMediaQuery('(min-width: 700px)')
	if (!view) return null

	if (view.minimized) {
		// Above the composer inside a thread, otherwise a floating bar.
		return slot ? (
			createPortal(
				<div className="px-[var(--chat-gut)] pb-2">
					<LiveCallBar view={view} floating={false} />
				</div>,
				slot,
			)
		) : (
			<LiveCallBar view={view} floating />
		)
	}

	if (wide) return <LiveCallPanel view={view} layout="panel" />
	// Narrow, outside a thread: the same dock, pinned to the bottom of the screen.
	return slot ? (
		createPortal(
			<div className="px-[var(--chat-gut)] pb-2">
				<LiveCallPanel view={view} layout="dock" />
			</div>,
			slot,
		)
	) : (
		<div className="fixed inset-x-2 bottom-2 z-50">
			<LiveCallPanel view={view} layout="dock" />
		</div>
	)
}
