import { getActorAvatarPaletteClass, getActorInitials } from '@/components/shared/actor-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CatalogPackageItem, CatalogPackageSummary, InstalledPackageRow } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useState } from 'react'
import { ForkDialog } from './fork-dialog'
import { InstallButton } from './install-button'
import { UninstallDialog } from './uninstall-dialog'
import { UpdateAvailableBanner } from './update-available-banner'

interface PackageCardProps {
	workspaceId: string
	pkg: CatalogPackageSummary
	install?: InstalledPackageRow
	/** The individual items in this bundle. Only used to render the composition chip
	 *  row on multi-type bundle cards; ignored on single-type packages. */
	items?: CatalogPackageItem[]
}

export function PackageCard({ workspaceId, pkg, install, items }: PackageCardProps) {
	const [forkOpen, setForkOpen] = useState(false)
	const [uninstallOpen, setUninstallOpen] = useState(false)
	const locked = install?.isLocked ?? false
	const forked = install ? !install.isLocked : false
	const showUpdateBanner = locked && install?.hasUpdate === true
	const showCompositionRow = pkg.item_types.length >= 2 && !!items && items.length > 0

	return (
		<article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{pkg.name}</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2">{pkg.description}</p>
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

			<div className="flex flex-wrap gap-1">
				{pkg.item_types.map((type) => (
					<span
						key={type}
						className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
					>
						{type}
					</span>
				))}
			</div>

			{showCompositionRow ? <CompositionChipRow items={items} /> : null}

			{showUpdateBanner ? <UpdateAvailableBanner newVersion={install.availableVersion} /> : null}

			<div className="mt-auto flex items-center justify-end gap-2">
				{!install ? (
					<InstallButton workspaceId={workspaceId} packageId={pkg.id} />
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
					installedPackageId={install.id}
					packageName={pkg.name}
					installedVersion={install.installedVersion}
					pendingVersion={install.hasUpdate ? install.availableVersion : null}
				/>
			) : null}

			{install ? (
				<UninstallDialog
					open={uninstallOpen}
					onOpenChange={setUninstallOpen}
					workspaceId={workspaceId}
					installedPackageId={install.id}
					packageName={pkg.name}
					isLocked={locked}
				/>
			) : null}

			{forked && install ? (
				<p className="text-[11px] text-muted-foreground">{forkedHint(install)}</p>
			) : null}
		</article>
	)
}

function forkedHint(install: InstalledPackageRow): string {
	if (!install.hasUpdate) return ''
	return `v${install.availableVersion} of the source is available. Your fork stays at v${install.installedVersion}.`
}

function itemName(item: CatalogPackageItem): string {
	const raw = item.item_snapshot?.name
	return typeof raw === 'string' && raw.trim() ? raw : 'Untitled'
}

function shortLabelFor(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	return words[0] ?? name
}

function firstInitial(name: string): string {
	return (name.trim()[0] ?? '?').toUpperCase()
}

interface CompositionChipRowProps {
	items: CatalogPackageItem[]
}

function CompositionChipRow({ items }: CompositionChipRowProps) {
	const actors = items.filter((i) => i.item_type === 'actor')
	const triggers = items.filter((i) => i.item_type === 'trigger')
	const skills = items.filter((i) => i.item_type === 'skill')
	const integrations = items.filter((i) => i.item_type === 'integration')

	if (actors.length + triggers.length + skills.length + integrations.length === 0) return null

	const triggerNames = triggers.map(itemName)

	return (
		<TooltipProvider delayDuration={150}>
			<div className="flex flex-wrap gap-1" aria-label="Package composition">
				{actors.map((item) => (
					<InitialChip key={item.id} name={itemName(item)} colored />
				))}
				{triggers.length > 0 && <TriggerCountChip count={triggers.length} names={triggerNames} />}
				{skills.map((item) => (
					<InitialChip key={item.id} name={itemName(item)} />
				))}
				{integrations.map((item) => (
					<InitialChip key={item.id} name={itemName(item)} />
				))}
			</div>
		</TooltipProvider>
	)
}

interface InitialChipProps {
	name: string
	/** Give the initial dot the deterministic actor palette color. Off = muted. */
	colored?: boolean
}

function InitialChip({ name, colored }: InitialChipProps) {
	const initial = firstInitial(name) || getActorInitials(name).slice(0, 1)
	const short = shortLabelFor(name)
	const paletteClass = colored ? getActorAvatarPaletteClass(name) : 'bg-muted text-muted-foreground'

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={name}
					className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-0.5 pr-2 text-[11px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						className={cn(
							'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none',
							paletteClass,
						)}
						aria-hidden="true"
					>
						{initial}
					</span>
					<span className="whitespace-nowrap">{short}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>{name}</TooltipContent>
		</Tooltip>
	)
}

interface TriggerCountChipProps {
	count: number
	names: string[]
}

function TriggerCountChip({ count, names }: TriggerCountChipProps) {
	const label = count === 1 ? '1 trigger' : `${count} triggers`
	const tooltip = names.length > 0 ? names.join(', ') : label

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={`${label}: ${tooltip}`}
					className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span aria-hidden="true">↯</span>
					<span className="whitespace-nowrap">{label}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	)
}
