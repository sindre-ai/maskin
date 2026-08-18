import { CURRENT_RELEASE, dismissRelease, isReleaseDismissed } from '@/lib/release-note'
import { X } from 'lucide-react'
import { useState } from 'react'

/**
 * Release announcement card in the sidebar footer — mockup lines 85–92.
 *
 * Dismissal is per version and lives in localStorage, so shipping a new
 * `CURRENT_RELEASE` re-surfaces the card without a server round-trip.
 */
export function SidebarReleaseCard() {
	const release = CURRENT_RELEASE
	const [dismissed, setDismissed] = useState(() => isReleaseDismissed(release.version))

	if (dismissed) return null

	return (
		<div
			data-testid="sidebar-release-card"
			className="relative rounded-xl border border-border bg-card px-3 py-[11px] shadow-sm group-data-[collapsible=icon]:hidden"
		>
			<button
				type="button"
				onClick={() => {
					dismissRelease(release.version)
					setDismissed(true)
				}}
				aria-label="Dismiss release note"
				className="absolute right-[7px] top-[7px] grid size-[18px] place-items-center rounded text-border-strong transition-colors duration-150 hover:bg-muted hover:text-foreground"
			>
				<X aria-hidden="true" className="size-3" />
			</button>
			{/* Mono micro-label. Not `.eyebrow` — that utility hard-codes
			    muted-foreground and sits in the same cascade layer as Tailwind's
			    colour utilities, so the brand tint here would be a coin flip. */}
			<span className="inline-flex h-[18px] items-center gap-[5px] rounded-full bg-brand-subtle px-2 font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-brand-subtle-foreground">
				<span aria-hidden="true" className="size-[5px] rounded-full bg-brand" />
				New
			</span>
			<div className="mt-2 text-[12.5px] font-bold tracking-[-0.01em] text-foreground">
				{release.title}
			</div>
			<div className="mt-0.5 text-[11px] leading-[1.45] text-muted-foreground">
				{release.summary}
			</div>
			{release.href && (
				<a
					href={release.href}
					target="_blank"
					rel="noreferrer"
					className="mt-[9px] inline-block text-[11px] font-semibold text-brand transition-colors duration-150 hover:text-brand-hover"
				>
					What's new →
				</a>
			)}
		</div>
	)
}
