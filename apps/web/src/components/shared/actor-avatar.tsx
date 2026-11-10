import { type PictogramShape, getAgentPictogram } from '@/lib/agent-pictogram'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { QueryClientContext, useQuery } from '@tanstack/react-query'
import { useContext, useState } from 'react'

const AVATAR_PALETTE = [
	'bg-[var(--st-in_progress-bg)] text-[var(--st-in_progress-text)]',
	'bg-[var(--st-active-bg)] text-[var(--st-active-text)]',
	'bg-[var(--st-opportunity-bg)] text-[var(--st-opportunity-text)]',
	'bg-[var(--st-clustered-bg)] text-[var(--st-clustered-text)]',
	'bg-[var(--st-in_review-bg)] text-[var(--st-in_review-text)]',
	'bg-[var(--st-validated-bg)] text-[var(--st-validated-text)]',
	'bg-[var(--st-qualified-bg)] text-[var(--st-qualified-text)]',
	'bg-[var(--st-scored-bg)] text-[var(--st-scored-text)]',
	'bg-[var(--st-processing-bg)] text-[var(--st-processing-text)]',
	'bg-[var(--st-proposed-bg)] text-[var(--st-proposed-text)]',
] as const

// The same ten identities as solid plates: the status *text* token becomes the
// fill and its tint becomes the glyph. v2 draws an agent's avatar this way
// wherever the avatar is the row's anchor (mockup 2329's `avStrong` + reversed
// foreground), and the pairing inverts correctly in dark mode because both
// halves are tokens.
const AVATAR_PALETTE_STRONG = [
	'bg-[var(--st-in_progress-text)] text-[var(--st-in_progress-bg)]',
	'bg-[var(--st-active-text)] text-[var(--st-active-bg)]',
	'bg-[var(--st-opportunity-text)] text-[var(--st-opportunity-bg)]',
	'bg-[var(--st-clustered-text)] text-[var(--st-clustered-bg)]',
	'bg-[var(--st-in_review-text)] text-[var(--st-in_review-bg)]',
	'bg-[var(--st-validated-text)] text-[var(--st-validated-bg)]',
	'bg-[var(--st-qualified-text)] text-[var(--st-qualified-bg)]',
	'bg-[var(--st-scored-text)] text-[var(--st-scored-bg)]',
	'bg-[var(--st-processing-text)] text-[var(--st-processing-bg)]',
	'bg-[var(--st-proposed-text)] text-[var(--st-proposed-bg)]',
] as const

// Glyph size for a three-letter acronym ("CTO"); lg and xl are wide enough as they are.
const THREE_LETTER_TEXT = {
	sm: 'text-[7.5px]',
	md: 'text-[10px]',
	lg: '',
	xl: '',
} as const

/** Tint plate (the default everywhere) vs the solid plate v2 uses for a row anchor. */
export type ActorAvatarTone = 'subtle' | 'strong'

/** Strip everything that is not a letter or digit so a bracketed qualifier
 *  ("Linker (Sigrid)") or a title suffix never lands in the glyph. A one-word
 *  all-caps name of 2 or 3 letters ("CTO", "PMM") is a role acronym and keeps
 *  every letter; everything else is cut to two. */
export function getActorInitials(name: string): string {
	const trimmed = (name ?? '').trim()
	if (!trimmed) return '?'
	const words = trimmed
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
		.filter(Boolean)
	if (words.length === 0) return '?'
	if (words.length >= 2) {
		const first = words[0]?.[0] ?? ''
		const second = words[1]?.[0] ?? ''
		const combined = (first + second).toUpperCase()
		return combined || '?'
	}
	const word = words[0] ?? ''
	if (/^\p{Lu}{2,3}$/u.test(word)) return word
	if (word.length >= 2) return word.slice(0, 2).toUpperCase()
	return word.toUpperCase() || '?'
}

function hashString(input: string): number {
	// djb2 xor variant — deterministic, no crypto needed for a color bucket
	let hash = 5381
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
	}
	return hash >>> 0
}

export function getActorAvatarPaletteClass(
	seed: string | undefined,
	tone: ActorAvatarTone = 'subtle',
): string {
	const key = seed && seed.length > 0 ? seed : '?'
	const palette = tone === 'strong' ? AVATAR_PALETTE_STRONG : AVATAR_PALETTE
	const idx = hashString(key) % palette.length
	return palette[idx] ?? palette[0]
}

// The workspace the avatar sits in, or undefined outside one (isolated renders, stories).
function useOptionalWorkspaceId(): string | undefined {
	try {
		return useWorkspace().workspaceId
	} catch {
		return undefined
	}
}

type ActorAvatarProps = {
	name: string
	type: string
	/** 20 / 28 / 38 / 52px. Overlapping avatar stacks size themselves with
	 *  `className` — they sit between steps and exist in exactly one place. */
	size?: 'sm' | 'md' | 'lg' | 'xl'
	className?: string
	onClick?: () => void
	id?: string
	imageUrl?: string
	/** `strong` fills the plate with the identity colour and reverses the glyph. */
	tone?: ActorAvatarTone
	/** Composes a violet conic-gradient ring around the avatar, animating
	 *  clockwise ~1.6s/rev; `prefers-reduced-motion: reduce` renders a static
	 *  300° arc. Wired on the Objects list row to `object.active_session_state
	 *  === 'running'` — the D2 delta of the v4 polish bet. `aria-label` names
	 *  the container "Agent working on this item" so screen readers announce
	 *  the state; the avatar itself keeps its existing name. */
	working?: boolean
	/** The v11 list-row driver: a 26px rounded-square plate in the neutral muted
	 *  fill with ink initials, instead of the round coloured avatar. */
	tile?: boolean
	/** v16 status dot on an agent's tile (from 24px up): green while it works, red
	 *  when its last run failed. Omit for an idle agent. Ignored for non-agents. */
	status?: 'working' | 'failed'
}

/**
 * Draws the actor's picture when it has one. Callers that already hold an
 * `avatar_url` pass it as `imageUrl`; every other call site that passes an
 * `id` gets it from the workspace actors list, so lists, chats and the sidebar
 * show pictures without each one threading the URL through. Outside a workspace
 * or query provider (stories, isolated tests) it draws initials only.
 */
export function ActorAvatar(props: ActorAvatarProps) {
	const queryClient = useContext(QueryClientContext)
	const workspaceId = useOptionalWorkspaceId()
	if (props.imageUrl === undefined && props.id && queryClient && workspaceId) {
		return <ActorAvatarWithLookup {...props} id={props.id} workspaceId={workspaceId} />
	}
	return <ActorAvatarView {...props} />
}

// Same key and fetcher as useActors, so this shares the list every other surface loads.
function useActorAvatarUrl(id: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.actors.all(workspaceId),
		queryFn: () => api.actors.list(workspaceId),
		select: (actors) => actors.find((actor) => actor.id === id)?.avatar_url ?? undefined,
	})
}

function ActorAvatarWithLookup({
	workspaceId,
	...props
}: ActorAvatarProps & { id: string; workspaceId: string }) {
	const { data: imageUrl } = useActorAvatarUrl(props.id, workspaceId)
	return <ActorAvatarView {...props} imageUrl={imageUrl} />
}

function ActorAvatarView({
	name,
	type: _type,
	size = 'sm',
	className,
	onClick,
	id,
	imageUrl,
	tone = 'subtle',
	working = false,
	tile = false,
	status,
}: ActorAvatarProps) {
	// Track the specific url that failed so a caller swapping imageUrl resets the fallback
	// automatically — without a useEffect that biome flags for missing dep semantics.
	const [failedUrl, setFailedUrl] = useState<string | null>(null)
	const imageFailed = imageUrl != null && failedUrl === imageUrl

	const sizeClasses = {
		sm: 'h-5 w-5 text-[10px]',
		md: 'h-7 w-7 text-xs',
		lg: 'h-[38px] w-[38px] text-sm',
		xl: 'h-[52px] w-[52px] text-lg',
	}[size]
	const initials = getActorInitials(name)
	const paletteClass = getActorAvatarPaletteClass(id ?? name, tone)
	const showImage = Boolean(imageUrl) && !imageFailed

	// Agents are drawn as a tinted tile with a pictogram (v16); people and anything
	// else keep the round initials plate. An uploaded picture still covers either.
	const pictogram = _type === 'agent' ? getAgentPictogram(name) : null

	const baseClasses = cn(
		'relative inline-flex items-center justify-center font-medium select-none',
		pictogram ? (size === 'sm' ? 'rounded-md' : 'rounded-lg') : 'rounded-full',
		paletteClass,
		sizeClasses,
		tile && 'size-[26px] rounded-lg bg-muted text-[10.5px] font-bold text-foreground',
		// Three letters need a smaller glyph at the small steps to stay inside the plate.
		initials.length === 3 && !pictogram && (tile ? 'text-[8.5px]' : THREE_LETTER_TEXT[size]),
		className,
		// Last, so the team tint wins over a caller's plain or status fill.
		pictogram?.tintClass,
	)

	const content = (
		<>
			{pictogram ? (
				<PictogramMark shapes={pictogram.shapes} />
			) : (
				<span className="leading-none" aria-hidden={showImage ? 'true' : undefined}>
					{initials}
				</span>
			)}
			{pictogram && status && size !== 'sm' ? (
				<span
					aria-hidden="true"
					data-avatar-status={status}
					className={cn(
						// 1px out, not 2: the avatar's scroll width must stay within the 1px overflow gate.
						'absolute -bottom-px -right-px rounded-full border-2 border-background',
						size === 'xl' ? 'size-3.5' : 'size-2.5',
						status === 'failed' ? 'bg-error' : 'bg-success motion-safe:animate-pulse',
					)}
				/>
			) : null}
			{imageUrl && !imageFailed ? (
				<img
					src={imageUrl}
					alt=""
					className={cn(
						'absolute inset-0 h-full w-full object-cover',
						tile || pictogram ? 'rounded-[inherit]' : 'rounded-full',
					)}
					onError={() => setFailedUrl(imageUrl)}
					draggable={false}
				/>
			) : null}
		</>
	)

	if (onClick) {
		return (
			<WorkingRing working={working}>
				<button
					type="button"
					onClick={onClick}
					title={name}
					aria-label={name}
					className={cn(
						baseClasses,
						'cursor-pointer transition-opacity hover:opacity-80',
						// Anchored to the right edge so the 44px hit area only grows leftward: a
						// centred one pokes past the button's right edge and counts as horizontal
						// overflow on every ancestor scroller.
						'after:absolute after:right-0 after:top-1/2 after:min-h-11 after:min-w-11 after:-translate-y-1/2 after:content-[""]',
					)}
				>
					{content}
				</button>
			</WorkingRing>
		)
	}

	return (
		<WorkingRing working={working}>
			<span title={name} className={baseClasses}>
				{content}
			</span>
		</WorkingRing>
	)
}

/** The pictogram itself: 62% of the tile, painted with the tile's ink colour. */
function PictogramMark({ shapes }: { shapes: PictogramShape[] }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-[62%]"
			fill="none"
			aria-hidden="true"
			focusable="false"
			data-pictogram
		>
			{shapes.map((shape, i) => {
				const key = `${shape[0]}-${i}`
				switch (shape[0]) {
					case 'c':
						return <circle key={key} cx={shape[1]} cy={shape[2]} r={shape[3]} fill="currentColor" />
					case 'rg':
						return (
							<circle
								key={key}
								cx={shape[1]}
								cy={shape[2]}
								r={shape[3]}
								stroke="currentColor"
								strokeWidth={shape[4]}
							/>
						)
					case 'p':
						return <path key={key} d={shape[1]} fill="currentColor" />
					case 'l':
						return (
							<path
								key={key}
								d={shape[1]}
								stroke="currentColor"
								strokeWidth={shape[2]}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						)
					case 'r':
						return (
							<rect
								key={key}
								x={shape[1]}
								y={shape[2]}
								width={shape[3]}
								height={shape[4]}
								rx={shape[5]}
								fill="currentColor"
							/>
						)
					case 'ro':
						return (
							<rect
								key={key}
								x={shape[1]}
								y={shape[2]}
								width={shape[3]}
								height={shape[4]}
								rx={shape[5]}
								stroke="currentColor"
								strokeWidth={2.6}
							/>
						)
				}
			})}
		</svg>
	)
}

// Wraps the avatar in a fixed-thickness violet conic-gradient ring, animated
// clockwise via CSS. Kept as an inline component so callers keep using
// `<ActorAvatar working />` without threading the wrapper themselves.
//
// The ring lives at `.actor-avatar-working-ring` — the animation and reduced-
// motion fallback are defined in `app.css` (a `@keyframes actor-avatar-ring`
// and the paired `@media (prefers-reduced-motion: reduce)` override). Keeping
// the visual definition in CSS keeps this component's markup readable and
// lets `@theme` tokens (var(--violet)) flow into it without JS colour math.
function WorkingRing({
	working,
	children,
}: {
	working: boolean
	children: React.ReactNode
}) {
	if (!working) return <>{children}</>
	return (
		<span
			aria-label="Agent working on this item"
			className="actor-avatar-working-ring relative inline-flex shrink-0 items-center justify-center"
		>
			{children}
		</span>
	)
}

/**
 * Lays an actor's picture over a plate the caller already draws (the sidebar
 * account row keeps its own tile). Draws nothing until the picture is known, so
 * the plate's letter shows through while it loads and when there is none.
 * The plate needs `relative overflow-hidden`.
 */
export function ActorPictureOverlay({ id }: { id: string }) {
	const queryClient = useContext(QueryClientContext)
	const workspaceId = useOptionalWorkspaceId()
	if (!queryClient || !workspaceId) return null
	return <ActorPictureOverlayWithLookup id={id} workspaceId={workspaceId} />
}

function ActorPictureOverlayWithLookup({ id, workspaceId }: { id: string; workspaceId: string }) {
	const { data: imageUrl } = useActorAvatarUrl(id, workspaceId)
	const [failedUrl, setFailedUrl] = useState<string | null>(null)
	if (!imageUrl || failedUrl === imageUrl) return null
	return (
		<img
			src={imageUrl}
			alt=""
			className="absolute inset-0 h-full w-full object-cover"
			onError={() => setFailedUrl(imageUrl)}
			draggable={false}
		/>
	)
}
