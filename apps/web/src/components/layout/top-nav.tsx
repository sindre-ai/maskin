import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import type * as React from 'react'

/**
 * v2 top navigation — the replacement for the old header/breadcrumb bar.
 *
 * Structure follows the `Maskin App v2 Standalone.html` mockup:
 * a centered row (max width ~700px) with a horizontally scrolling strip of
 * segmented tabs and filter chips on the left, and a "more" icon button plus
 * a view/menu trigger on the right. It is designed to sit above the page
 * content, spanning the app content area (not the sidebar) — flush at the
 * top with a small clamp'd horizontal padding so it never touches the edge.
 *
 * Everything visual is token-driven (no hex, no arbitrary font sizes).
 */

export interface TopNavTab {
	key: string
	label: string
	active?: boolean
}

export interface TopNavFilterChip {
	key: string
	label: string
	count?: number
	active?: boolean
	onClick?: () => void
}

export interface TopNavProps extends React.HTMLAttributes<HTMLDivElement> {
	tabs?: TopNavTab[]
	activeTabKey?: string
	onTabChange?: (key: string) => void
	filters?: TopNavFilterChip[]
	moreLabel?: string
	menuLabel?: string
	menuIcon?: React.ReactNode
	onMoreClick?: () => void
	onMenuClick?: () => void
	/** Render props for extra trailing controls (e.g. a New button). */
	trailing?: React.ReactNode
}

export function TopNav({
	tabs,
	activeTabKey,
	onTabChange,
	filters,
	moreLabel = 'More',
	menuLabel,
	menuIcon,
	onMoreClick,
	onMenuClick,
	trailing,
	className,
	...rest
}: TopNavProps) {
	return (
		<div
			className={cn('flex flex-none justify-center px-3 pb-1 pt-3 sm:px-6 md:px-7', className)}
			{...rest}
		>
			<div className="flex w-full max-w-[700px] items-center gap-1.5">
				<div
					data-scroll="horizontal"
					className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{tabs && tabs.length > 0 ? (
						<div className="mr-1 flex flex-none items-center gap-0.5">
							{tabs.map((tab) => (
								<TopNavTabButton
									key={tab.key}
									tab={tab}
									isActive={activeTabKey ? tab.key === activeTabKey : Boolean(tab.active)}
									onSelect={onTabChange}
								/>
							))}
						</div>
					) : null}
					{filters?.map((chip) => (
						<TopNavChip key={chip.key} chip={chip} />
					))}
				</div>
				<div className="flex flex-none items-center gap-1.5">
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label={moreLabel}
						title={moreLabel}
						onClick={onMoreClick}
						className="h-[30px] w-[30px] rounded-lg border-border text-muted-foreground hover:border-border-strong hover:text-foreground"
					>
						<MoreHorizontal aria-hidden="true" className="size-[14px]" />
					</Button>
					{menuLabel ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onMenuClick}
							className="h-[30px] gap-1.5 rounded-lg border-border px-3 text-[11.5px] font-semibold text-muted-foreground hover:border-border-strong hover:text-foreground"
						>
							{menuIcon}
							<span className="max-w-[200px] truncate">{menuLabel}</span>
							<ChevronDown aria-hidden="true" className="size-3 text-border-strong" />
						</Button>
					) : null}
					{trailing}
				</div>
			</div>
		</div>
	)
}

function TopNavTabButton({
	tab,
	isActive,
	onSelect,
}: {
	tab: TopNavTab
	isActive: boolean
	onSelect?: (key: string) => void
}) {
	return (
		<button
			type="button"
			onClick={onSelect ? () => onSelect(tab.key) : undefined}
			aria-pressed={isActive}
			className={cn(
				'inline-flex h-7 items-center whitespace-nowrap rounded-md px-2.5 text-[12.5px] transition-colors',
				isActive
					? 'bg-secondary font-semibold text-foreground'
					: 'font-medium text-muted-foreground hover:text-foreground',
			)}
		>
			{tab.label}
		</button>
	)
}

function TopNavChip({ chip }: { chip: TopNavFilterChip }) {
	return (
		<button
			type="button"
			onClick={chip.onClick}
			aria-pressed={chip.active}
			className={cn(
				'inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 text-[11.5px] font-semibold transition-colors hover:border-border-strong',
				chip.active ? 'text-foreground' : 'text-muted-foreground',
			)}
		>
			<span>{chip.label}</span>
			{typeof chip.count === 'number' ? (
				<span className="text-[10.5px] font-semibold text-border-strong">{chip.count}</span>
			) : null}
		</button>
	)
}

export default TopNav
