import { cn } from '@/lib/cn'
import { useState } from 'react'

const AVATAR_PALETTE = [
	'bg-[var(--st-in_progress-bg)] text-[var(--st-in_progress-text)]',
	'bg-[var(--st-active-bg)] text-[var(--st-active-text)]',
	'bg-[var(--st-signal-bg)] text-[var(--st-signal-text)]',
	'bg-[var(--st-clustered-bg)] text-[var(--st-clustered-text)]',
	'bg-[var(--st-in_review-bg)] text-[var(--st-in_review-text)]',
	'bg-[var(--st-validated-bg)] text-[var(--st-validated-text)]',
	'bg-[var(--st-qualified-bg)] text-[var(--st-qualified-text)]',
	'bg-[var(--st-scored-bg)] text-[var(--st-scored-text)]',
	'bg-[var(--st-processing-bg)] text-[var(--st-processing-text)]',
	'bg-[var(--st-proposed-bg)] text-[var(--st-proposed-text)]',
] as const

export function getActorInitials(name: string): string {
	const trimmed = (name ?? '').trim()
	if (!trimmed) return '?'
	const words = trimmed.split(/\s+/).filter(Boolean)
	if (words.length >= 2) {
		const first = words[0]?.[0] ?? ''
		const second = words[1]?.[0] ?? ''
		const combined = (first + second).toUpperCase()
		return combined || '?'
	}
	const word = words[0] ?? ''
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

export function ActorAvatar({
	name,
	type: _type,
	size = 'sm',
	className,
	onClick,
	id,
	imageUrl,
	variant = 'default',
}: {
	name: string
	type: string
	size?: 'sm' | 'md'
	className?: string
	onClick?: () => void
	id?: string
	imageUrl?: string
	/** `cos` renders the Chief-of-Staff purple gradient + live-status dot from
	 * chats-cos-explicit.html (::after pseudo-element). Everywhere else stays
	 * on the hashed palette so unrelated agents don't drift into the CoS look. */
	variant?: 'default' | 'cos'
}) {
	// Track the specific url that failed so a caller swapping imageUrl resets the fallback
	// automatically — without a useEffect that biome flags for missing dep semantics.
	const [failedUrl, setFailedUrl] = useState<string | null>(null)
	const imageFailed = imageUrl != null && failedUrl === imageUrl

	const sizeClasses = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs'
	const initials = getActorInitials(name)
	const isCos = variant === 'cos'
	const paletteClass = isCos
		? 'text-white [background-image:linear-gradient(135deg,#7c3aed_0%,#4338ca_100%)]'
		: getActorAvatarPaletteClass(id ?? name)
	const showImage = Boolean(imageUrl) && !imageFailed

	const baseClasses = cn(
		'relative inline-flex items-center justify-center rounded-full font-medium select-none',
		paletteClass,
		sizeClasses,
		className,
	)

	// Live-status dot on the Chief-of-Staff avatar (chats-cos-explicit.html
	// `.chat-av.cos::after`). Rendered as a positioned span rather than an
	// ::after pseudo — the button branch below already uses ::after for its
	// tap-target expansion, and CSS allows only one ::after per element.
	const cosDot = isCos ? (
		<span
			aria-hidden
			className={cn(
				'absolute -right-0.5 -bottom-0.5 rounded-full bg-success ring-2 ring-background',
				size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
			)}
			data-testid="cos-status-dot"
		/>
	) : null

	const content = (
		<>
			<span className="leading-none" aria-hidden={showImage ? 'true' : undefined}>
				{initials}
			</span>
			{imageUrl && !imageFailed ? (
				<img
					src={imageUrl}
					alt=""
					className="absolute inset-0 h-full w-full rounded-full object-cover"
					onError={() => setFailedUrl(imageUrl)}
					draggable={false}
				/>
			) : null}
			{cosDot}
		</>
	)

	if (onClick) {
		return (
			<button
				type="button"
				onClick={onClick}
				title={name}
				aria-label={name}
				className={cn(
					baseClasses,
					'cursor-pointer transition-opacity hover:opacity-80',
					'after:absolute after:left-1/2 after:top-1/2 after:min-h-11 after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[""]',
				)}
			>
				{content}
			</button>
		)
	}

	return (
		<span title={name} className={baseClasses}>
			{content}
		</span>
	)
}
