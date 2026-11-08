import { Link, type LinkProps } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

/**
 * A settings row that opens another page: title, one-line description and a
 * chevron. The whole row is the link (the anchor stretches over it), so the tap
 * target is the full row, at least 44px tall.
 */
export function SettingsLinkRow({
	title,
	description,
	...link
}: { title: string; description: string } & Pick<LinkProps, 'to' | 'params' | 'search'>) {
	return (
		<div className="relative flex min-h-11 items-center justify-between gap-4 px-2 py-3.5 transition-colors hover:bg-secondary/60">
			<div className="min-w-0">
				<span className="block text-[15px] font-medium leading-tight">
					<Link {...(link as LinkProps)} className="after:absolute after:inset-0">
						{title}
					</Link>
				</span>
				<span className="block text-[13px] text-muted-foreground">{description}</span>
			</div>
			<ChevronRight size={18} aria-hidden className="shrink-0 text-muted-foreground" />
		</div>
	)
}
