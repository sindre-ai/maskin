/**
 * The live call, drawn where the page has room: a right-hand panel while it is
 * expanded, a dock above the composer on narrow screens, and a bar once it is
 * minimised. Exactly one of them at a time. They all read the view the
 * call's owner (VoiceCallDialog) publishes; none of them owns the call.
 */

import { AgentAvatar } from '@/components/agents/voice-call-dialog'
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
import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

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
	return (
		<output
			aria-label={`Live call with ${view.agent.name}`}
			className={cn(
				'inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-brand-subtle px-3 font-mono text-[13px] font-semibold text-brand-subtle-foreground md:h-9',
				className,
			)}
		>
			<span aria-hidden="true" className="size-2 rounded-full bg-brand" />
			{formatCallClock(elapsed)}
		</output>
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

/** The expanded call: a right-hand column (`panel`) or a card above the composer (`dock`). */
function LiveCallPanel({ view, layout }: { view: VoiceCallView; layout: 'panel' | 'dock' }) {
	const elapsed = useElapsed(view.liveSince)
	const speaking = view.state === 'live-agent-speaking'
	const status = voiceCallStatus(view.state)
	const collapse = (
		<button
			type="button"
			aria-label="Minimise call"
			onClick={() => view.setMinimized(true)}
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
				<div className="px-3.5">
					<Caption view={view} />
				</div>
				<Controls view={view} />
			</section>
		)
	}

	return (
		<aside
			aria-label={`Call with ${view.agent.name}`}
			data-voice-call-surface="panel"
			className="flex w-[300px] shrink-0 flex-col border-l border-border bg-background lg:w-[340px]"
		>
			<div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
				<span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-subtle-foreground">
					<span aria-hidden="true" className="size-2 rounded-full bg-brand" />
					Live
				</span>
				<span className="flex items-center gap-2 font-mono text-[13px] font-semibold text-foreground">
					{formatCallClock(elapsed)}
					{collapse}
				</span>
			</div>
			<div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto px-4 pt-8">
				<AgentAvatar agent={view.agent} state={view.state} sizeClass="size-24 text-3xl" />
				<p className="text-lg font-bold text-foreground">{view.agent.name}</p>
				<p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
					<Bars active={speaking} />
					{status}
				</p>
				<div className="w-full">
					<Caption view={view} />
				</div>
			</div>
			<div className="border-t border-border">
				<Controls view={view} />
			</div>
		</aside>
	)
}

/** The minimised call: a 56px pill that follows the person across pages. */
function LiveCallBar({ view, floating }: { view: VoiceCallView; floating: boolean }) {
	const elapsed = useElapsed(view.liveSince)
	const muted = view.state === 'live-muted'
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
	// Narrow, outside a thread: nowhere to dock, so keep the call as the bar.
	return slot ? (
		createPortal(
			<div className="px-[var(--chat-gut)] pb-2">
				<LiveCallPanel view={view} layout="dock" />
			</div>,
			slot,
		)
	) : (
		<LiveCallBar view={view} floating />
	)
}
