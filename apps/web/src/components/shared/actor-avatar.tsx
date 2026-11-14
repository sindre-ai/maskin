import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { QueryClientContext, useQuery } from '@tanstack/react-query'
import { type CSSProperties, useContext, useState } from 'react'

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

/** The letters to draw: the ones the agent chose when it has set any, else the automatic ones. */
export function resolveActorInitials(name: string, chosen?: string | null): string {
	const set = chosen?.trim()
	return set ? set.toUpperCase() : getActorInitials(name)
}

/** Strip everything that is not a letter or digit so a bracketed qualifier
 *  ("Linker (Sigrid)") or a title suffix never lands in the glyph. A single
 *  all-caps word of 3 letters (CTO, CPO, PMM) keeps all three; names of three
 *  or more words use the first letter of the first three words (Chief of Staff
 *  is COS); every other name stays at two. */
export function getActorInitials(name: string): string {
	const trimmed = (name ?? '').trim()
	if (!trimmed) return '?'
	const words = trimmed
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
		.filter(Boolean)
	if (words.length === 0) return '?'
	if (words.length >= 2) {
		const combined = words
			.slice(0, 3)
			.map((word) => word[0] ?? '')
			.join('')
			.toUpperCase()
		return combined || '?'
	}
	const word = words[0] ?? ''
	if (/^\p{Lu}{3}$/u.test(word)) return word
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

export function getActorAvatarPaletteClass(seed: string | undefined): string {
	const key = seed && seed.length > 0 ? seed : '?'
	const idx = hashString(key) % AVATAR_PALETTE.length
	return AVATAR_PALETTE[idx] ?? AVATAR_PALETTE[0]
}

/** The actor's hue, 0..359, folded over every character of the seed (the id, else the
 *  name). Same fold as the app's ActorIdentity.hue, so an actor has one colour on every client. */
export function getActorHue(seed: string | undefined): number {
	let hue = 0
	const key = seed && seed.length > 0 ? seed : '?'
	for (let i = 0; i < key.length; i++) {
		hue = (hue * 31 + key.charCodeAt(i)) % 360
	}
	return hue
}

/** The app's avatar plate: a 135 degree gradient from one hue to the same hue plus 38 degrees,
 *  with a soft white highlight over the upper half. The same in light and dark. White letters
 *  go on it. The radius is a percentage of the plate, so it follows whatever size the caller sets. */
export function getActorPlateStyle(seed: string | undefined): CSSProperties {
	const hue = getActorHue(seed)
	return {
		backgroundImage: `linear-gradient(to bottom, rgba(255,255,255,0.18), rgba(255,255,255,0) 50%), linear-gradient(135deg, hsl(${hue} 52% 44%), hsl(${(hue + 38) % 360} 58% 32%))`,
		borderRadius: '30%',
		color: '#fff',
	}
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
	/** The letters the agent chose for itself (`initials` on the actor record). Set, they replace the
	 *  automatic ones. A caller that passes its own `imageUrl` passes this too, because no lookup runs then. */
	initials?: string | null
	/** Composes a violet conic-gradient ring around the avatar, animating
	 *  clockwise ~1.6s/rev; `prefers-reduced-motion: reduce` renders a static
	 *  300° arc. Wired on the Objects list row to `object.active_session_state
	 *  === 'running'` — the D2 delta of the v4 polish bet. `aria-label` names
	 *  the container "Agent working on this item" so screen readers announce
	 *  the state; the avatar itself keeps its existing name. */
	working?: boolean
	/** The v11 list-row driver: the same plate at a fixed 26px. */
	tile?: boolean
	/** v16 status dot on an agent's tile (from 24px up): green while it works, red
	 *  when its last run failed. Omit for an idle agent. Ignored for non-agents. */
	status?: 'working' | 'failed'
}

/**
 * Draws the actor's picture and chosen letters when it has them. Callers that already hold an
 * `avatar_url` pass it as `imageUrl` (and `initials` with it); every other call site that passes an
 * `id` gets both from the workspace actors list, so lists, chats and the sidebar
 * show them without each one threading the values through. Outside a workspace
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
function useActorAvatarLook(id: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.actors.all(workspaceId),
		queryFn: () => api.actors.list(workspaceId),
		select: (actors) => {
			const actor = actors.find((candidate) => candidate.id === id)
			return { imageUrl: actor?.avatar_url ?? undefined, initials: actor?.initials ?? undefined }
		},
	})
}

function ActorAvatarWithLookup({
	workspaceId,
	...props
}: ActorAvatarProps & { id: string; workspaceId: string }) {
	const { data } = useActorAvatarLook(props.id, workspaceId)
	return <ActorAvatarView {...props} imageUrl={data?.imageUrl} initials={data?.initials} />
}

function ActorAvatarView({
	name,
	type,
	size = 'sm',
	className,
	onClick,
	id,
	imageUrl,
	initials: chosenInitials,
	working = false,
	tile = false,
	status,
}: ActorAvatarProps) {
	// Track the specific url that failed so a caller swapping imageUrl resets the fallback
	// automatically — without a useEffect that biome flags for missing dep semantics.
	const [failedUrl, setFailedUrl] = useState<string | null>(null)
	const imageFailed = imageUrl != null && failedUrl === imageUrl

	const initials = resolveActorInitials(name, chosenInitials)
	// Three letters (CTO, PMM) get a smaller glyph so the widest ones still sit inside the plate.
	const threeLetters = initials.length === 3
	const sizeClasses = {
		sm: 'h-5 w-5',
		md: 'h-7 w-7',
		lg: 'h-[38px] w-[38px]',
		xl: 'h-[52px] w-[52px]',
	}[size]
	const showImage = Boolean(imageUrl) && !imageFailed

	const baseClasses = cn(
		// A size container, so the glyph can be sized as a share of the plate whatever size the caller sets.
		'relative inline-flex items-center justify-center font-bold select-none [container-type:size]',
		sizeClasses,
		tile && 'size-[26px]',
		className,
	)
	// Inline, so a caller's own radius or fill cannot undo the look the app has.
	const plateStyle = getActorPlateStyle(id ?? name)
	const isAgent = type === 'agent'

	const content = (
		<>
			<span
				className={cn('leading-none', threeLetters ? 'text-[length:28cqw]' : 'text-[length:36cqw]')}
				aria-hidden={showImage ? 'true' : undefined}
			>
				{initials}
			</span>
			{isAgent && status && size !== 'sm' ? (
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
					className="absolute inset-0 h-full w-full rounded-[inherit] object-cover"
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
					style={plateStyle}
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
			<span title={name} style={plateStyle} className={baseClasses}>
				{content}
			</span>
		</WorkingRing>
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
	const { data } = useActorAvatarLook(id, workspaceId)
	const imageUrl = data?.imageUrl
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
