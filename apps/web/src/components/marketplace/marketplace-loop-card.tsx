import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
	InstalledLoopRow,
	MarketplaceItemType,
	MarketplaceLoopItem,
	MarketplaceLoopSummary,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { UninstallDialog } from './uninstall-dialog'
import { UpdateAvailableBanner } from './update-available-banner'

interface MarketplaceLoopCardProps {
	workspaceId: string
	loop: MarketplaceLoopSummary
	install?: InstalledLoopRow
	/**
	 * Items belonging to this loop. Used to render the composition chip row
	 * on bundle cards (loops with ≥2 component types). When omitted or empty
	 * on a bundle card, the row silently hides.
	 */
	items?: MarketplaceLoopItem[]
}

export function MarketplaceLoopCard({
	workspaceId,
	loop,
	install,
	items,
}: MarketplaceLoopCardProps) {
	const [forkOpen, setForkOpen] = useState(false)
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false
	const showUpdateBanner = locked && install?.hasUpdate === true
	const isBundle = loop.item_types.length >= 2

	return (
		<article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{loop.name}</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2">{loop.description}</p>
				</div>
				{install ? (
					locked ? (
						<Badge
							variant="secondary"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium"
						>
							🔒 Managed · v{install.installedVersion}
						</Badge>
					) : (
						<Badge
							variant="outline"
							className="shrink-0 whitespace-nowrap text-[11px] font-medium text-foreground"
						>
							⑂ Forked from v{install.installedVersion}
						</Badge>
					)
				) : null}
			</div>

			{isBundle && items && items.length > 0 ? (
				<CompositionChipRow items={items} />
			) : (
				<div className="flex flex-wrap gap-1">
					{loop.item_types.map((type) => (
						<span
							key={type}
							className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
						>
							{type}
						</span>
					))}
				</div>
			)}

			{showUpdateBanner ? <UpdateAvailableBanner newVersion={install.availableVersion} /> : null}

			<div className="mt-auto flex items-center justify-end gap-2">
				{!install ? (
					<InstallButton workspaceId={workspaceId} loopId={loop.id} />
				) : (
					<>
						{locked && (
							<Button size="sm" variant="outline" onClick={() => setForkOpen(true)}>
								Fork
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							className="text-muted-foreground hover:text-error"
							onClick={() => setUninstallOpen(true)}
						>
							Remove
						</Button>
					</>
				)}
			</div>

			{install && locked ? (
				<ForkDialog
					open={forkOpen}
					onOpenChange={setForkOpen}
					workspaceId={workspaceId}
					installedLoopId={install.id}
					loopName={loop.name}
					installedVersion={install.installedVersion}
					pendingVersion={install.hasUpdate ? install.availableVersion : null}
				/>
			) : null}

			{install ? (
				<UninstallDialog
					open={uninstallOpen}
					onOpenChange={setUninstallOpen}
					workspaceId={workspaceId}
					installedLoopId={install.id}
					loopName={loop.name}
					isLocked={locked}
				/>
			) : null}

			{forked && install ? (
				<p className="text-[11px] text-muted-foreground">{forkedHint(install)}</p>
			) : null}
		</article>
	)
}

function forkedHint(install: InstalledLoopRow): string {
	if (!install.hasUpdate) return ''
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}

// Shape the raw marketplace items into the chip descriptors the row renders:
// a single chip per integration, plus a count chip for agents and triggers
// whenever there's more than one — a lone agent still gets its own named chip.
type CompositionChip =
	| { key: string; kind: 'actor'; name: string; label: string; initial: string }
	| { key: string; kind: 'count'; itemKind: 'agent' | 'trigger'; count: number; names: string[] }
	| { key: string; kind: 'integration'; name: string; label: string; initial: string }

function itemName(item: MarketplaceLoopItem): string {
	const raw = (item.item_snapshot as { name?: unknown } | null)?.name
	return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'Untitled'
}

function buildChips(items: MarketplaceLoopItem[]): CompositionChip[] {
	const chips: CompositionChip[] = []
	const actorNames: string[] = []
	const triggerNames: string[] = []

	for (const item of items) {
		const type = item.item_type as MarketplaceItemType
		if (type === 'actor') {
			actorNames.push(itemName(item))
		} else if (type === 'integration') {
			const name = itemName(item)
			chips.push({
				key: `integration-${item.id}`,
				kind: 'integration',
				name,
				label: name,
				initial: (name[0] ?? '?').toUpperCase(),
			})
		} else if (type === 'trigger') {
			triggerNames.push(itemName(item))
		}
	}

	if (actorNames.length === 1) {
		const name = actorNames[0]
		chips.unshift({
			key: 'actor-single',
			kind: 'actor',
			name,
			label: name,
			initial: (getActorInitials(name)[0] ?? '?').toUpperCase(),
		})
	} else if (actorNames.length > 1) {
		chips.unshift({
			key: 'agents-count',
			kind: 'count',
			itemKind: 'agent',
			count: actorNames.length,
			names: actorNames,
		})
	}

	if (triggerNames.length > 0) {
		chips.push({
			key: 'triggers-count',
			kind: 'count',
			itemKind: 'trigger',
			count: triggerNames.length,
			names: triggerNames,
		})
	}

	return chips
}

function CompositionChipRow({ items }: { items: MarketplaceLoopItem[] }) {
	const chips = buildChips(items)
	if (chips.length === 0) return null

	return (
		<TooltipProvider delayDuration={150}>
			<div
				className="flex flex-wrap gap-1"
				aria-label="Bundle composition"
				data-testid="composition-chip-row"
			>
				{chips.map((chip) => {
					const tip =
						chip.kind === 'actor'
							? `Agent · ${chip.name}`
							: chip.kind === 'integration'
								? `Integration · ${chip.name}`
								: chip.names.join(' · ')
					const label =
						chip.kind === 'count'
							? `${chip.count} ${chip.itemKind}${chip.count === 1 ? '' : 's'}`
							: chip.label
					return (
						<Tooltip key={chip.key}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={tip}
									className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-muted-foreground cursor-help hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<CompositionGlyph chip={chip} />
									<span className="truncate">{label}</span>
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">{tip}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</TooltipProvider>
	)
}

function CompositionGlyph({ chip }: { chip: CompositionChip }) {
	const base =
		'inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none shrink-0'
	if (chip.kind === 'actor') {
		return (
			<span className={cn(base, getActorAvatarPaletteClass(chip.name))} aria-hidden="true">
				{chip.initial}
			</span>
		)
	}
	if (chip.kind === 'integration') {
		return (
			<span
				className={cn(base, 'border border-border bg-muted text-muted-foreground')}
				aria-hidden="true"
			>
				{chip.initial}
			</span>
		)
	}
	return (
		<span
			className={cn(base, 'border border-border bg-muted text-muted-foreground')}
			aria-hidden="true"
		>
			{chip.itemKind === 'agent' ? 'A' : '↯'}
		</span>
	)
}
