import { CURRENT_RELEASE, dismissRelease, isReleaseDismissed } from '@/lib/release-note'
import { X } from 'lucide-react'
import { useState } from 'react'

/**
 * What changed in the product, announced at the top of the feed (Feed v4,
 * lines 137–171). It sits under today's brief and above the cards, and stays
 * dismissed per version — shipping a new `CURRENT_RELEASE` brings it back
 * without a server round-trip.
 */
export function ReleaseCard() {
	const release = CURRENT_RELEASE
	const [dismissed, setDismissed] = useState(() => isReleaseDismissed(release.version))

	if (dismissed) return null

	return (
		<div
			data-testid="foryou-release-card"
			className="mt-1.5 overflow-hidden rounded-xl border border-border bg-card"
		>
			<div className="flex items-center gap-[9px] border-b border-muted px-3.5 py-[11px]">
				<span className="eyebrow shrink-0 tracking-[0.1em]">Update</span>
				<span className="shrink-0 font-mono text-[10.5px] font-semibold text-border-strong">
					v{release.version}
				</span>
				<span className="flex-1" />
				<button
					type="button"
					onClick={() => {
						dismissRelease(release.version)
						setDismissed(true)
					}}
					aria-label="Dismiss the release note"
					className="grid size-6 shrink-0 place-items-center rounded-md text-border-strong transition-colors duration-150 hover:bg-secondary hover:text-foreground"
				>
					<X aria-hidden className="size-3" />
				</button>
			</div>

			<div className="flex gap-3 px-4 pb-[15px] pt-3.5">
				<span
					aria-hidden
					className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-gradient-to-br from-muted-foreground to-foreground text-[9px] font-bold text-background"
				>
					M
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-bold leading-[1.35] tracking-[-0.015em] text-pretty text-foreground">
						{release.headline}
					</div>

					{release.changes.length > 0 && (
						<ul className="mt-[11px] flex flex-col gap-[9px]">
							{release.changes.map((change) => (
								<li key={change.text} className="flex items-baseline gap-2.5">
									<span aria-hidden className="mt-1.5 size-[5px] shrink-0 rounded-full bg-border" />
									<span className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-pretty text-muted-foreground">
										{change.text}{' '}
										{change.link && (
											<a
												href={change.link.href}
												className="whitespace-nowrap font-semibold text-brand hover:underline"
											>
												{change.link.label}
											</a>
										)}
									</span>
								</li>
							))}
						</ul>
					)}

					{release.note && (
						<p className="mt-3 text-[11.5px] leading-[1.55] text-pretty text-muted-foreground">
							{release.note}
						</p>
					)}
				</div>
			</div>
		</div>
	)
}
