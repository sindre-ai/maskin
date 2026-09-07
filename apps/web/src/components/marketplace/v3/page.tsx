/**
 * Marketplace v3 page — the shell that hosts the four tabs, the By-team
 * chip rail, five content bands, and the install-modal family. The whole
 * surface is scoped under `.marketplace-v3` so its tokens don't leak into
 * the rest of the app.
 *
 * Wired against `useMarketplaceCatalog()` — a TanStack Query hook that
 * today reads from the client-side seed (design spec §Copy verbatim), and
 * tomorrow (once Marketplace PR #3 lands) reads from
 * GET /api/marketplace/catalog. Contract per tech spec §6.1 is stable.
 */

import { useCallback, useRef, useState } from 'react'
import type { CatalogItemCard, MarketplaceItemKind, MarketplaceTeam } from './catalog'
import { TEAM_LABELS, teamLabel, useMarketplaceCatalog } from './catalog'
import { CompactCard, LoopCard, RecommendedCard } from './cards'
import { InstallModal, type InstallModalVariant } from './install-modal'
import './tokens.css'

type TabKey = 'featured' | 'loops' | 'agents' | 'skills' | 'tools'

const TABS: Array<{ key: TabKey; label: string }> = [
	{ key: 'featured', label: 'Featured' },
	{ key: 'loops', label: 'Loops' },
	{ key: 'agents', label: 'Agents' },
	{ key: 'skills', label: 'Skills' },
	{ key: 'tools', label: 'Tools' },
]

export function MarketplaceV3Page({ workspaceId }: { workspaceId: string }) {
	const [tab, setTab] = useState<TabKey>('featured')
	const [team, setTeam] = useState<MarketplaceTeam | 'all'>('all')
	const [query, setQuery] = useState('')

	const teamFilter: MarketplaceTeam | undefined = team === 'all' ? undefined : team
	const catalog = useMarketplaceCatalog(workspaceId, teamFilter)

	const [modalItem, setModalItem] = useState<CatalogItemCard | null>(null)
	const [modalVariant, setModalVariant] = useState<InstallModalVariant>('needs-decision')
	const onInstall = useCallback((item: CatalogItemCard) => {
		setModalVariant(pickInitialVariant(item))
		setModalItem(item)
	}, [])
	const closeModal = useCallback(() => setModalItem(null), [])

	const bands = catalog.data?.bands
	const tabCounts = catalog.data?.tab_counts ?? { loops: 0, agents: 0, skills: 0, tools: 0 }

	// Wrap the whole surface in `.marketplace-v3` so all tokens + selectors
	// scope to it (the app's zinc chrome outside this class is untouched).
	return (
		<div className="marketplace-v3">
			<TopBar
				tab={tab}
				onTabChange={setTab}
				tabCounts={tabCounts}
				query={query}
				onQueryChange={setQuery}
			/>
			<ChipRail team={team} onTeamChange={setTeam} />
			<div className="mp-content">
				{catalog.isError ? (
					<BandError onRetry={() => catalog.refetch()} />
				) : catalog.isLoading || !bands ? (
					<>
						<Band title="Recommended for you" note="from what your workspace already runs">
							<div className="mp-rec-grid" aria-busy="true">
								<CardSkeleton />
								<CardSkeleton />
								<CardSkeleton />
							</div>
						</Band>
					</>
				) : (
					<AllBands
						tab={tab}
						bands={bands}
						team={team}
						onInstall={onInstall}
					/>
				)}
			</div>
			{modalItem ? (
				<InstallModal
					item={modalItem}
					initialVariant={modalVariant}
					workspaceId={workspaceId}
					onClose={closeModal}
				/>
			) : null}
		</div>
	)
}

// ————— Top bar ————— //

function TopBar({
	tab,
	onTabChange,
	tabCounts,
	query,
	onQueryChange,
}: {
	tab: TabKey
	onTabChange: (t: TabKey) => void
	tabCounts: Record<'loops' | 'agents' | 'skills' | 'tools', number>
	query: string
	onQueryChange: (q: string) => void
}) {
	// Roving-tabindex tab strip per design spec §Accessibility.
	const listRef = useRef<HTMLDivElement>(null)
	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
		e.preventDefault()
		const buttons = Array.from(
			listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
		)
		const currentIdx = buttons.findIndex((b) => b === document.activeElement)
		const nextIdx =
			e.key === 'ArrowRight'
				? (currentIdx + 1) % buttons.length
				: (currentIdx - 1 + buttons.length) % buttons.length
		const next = buttons[nextIdx]
		if (next) {
			next.focus()
			onTabChange(next.dataset.tab as TabKey)
		}
	}

	return (
		<div className="mp-topbar">
			<h1>Marketplace</h1>
			<div className="mp-tabs" role="tablist" ref={listRef} onKeyDown={onKeyDown}>
				{TABS.map((t) => {
					const count = tabCountFor(t.key, tabCounts)
					const label = count != null ? `${t.label}, ${count} items` : t.label
					return (
						<button
							key={t.key}
							type="button"
							role="tab"
							data-tab={t.key}
							aria-selected={tab === t.key}
							aria-label={label}
							tabIndex={tab === t.key ? 0 : -1}
							className="mp-tab"
							onClick={() => onTabChange(t.key)}
						>
							{t.label}
							{count != null ? <span className="count">{count}</span> : null}
						</button>
					)
				})}
			</div>
			<div className="mp-top-actions">
				<div className="mp-search" role="search">
					<SearchIcon />
					<input
						placeholder="Search catalog"
						aria-label="Search catalog"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
					/>
				</div>
			</div>
		</div>
	)
}

function tabCountFor(
	tab: TabKey,
	counts: Record<'loops' | 'agents' | 'skills' | 'tools', number>,
): number | null {
	if (tab === 'featured') return null
	return counts[tab] ?? 0
}

// ————— By-team chip rail ————— //

function ChipRail({
	team,
	onTeamChange,
}: {
	team: MarketplaceTeam | 'all'
	onTeamChange: (t: MarketplaceTeam | 'all') => void
}) {
	const listRef = useRef<HTMLDivElement>(null)
	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
		e.preventDefault()
		const chips = Array.from(
			listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
		)
		const currentIdx = chips.findIndex((b) => b === document.activeElement)
		const nextIdx =
			e.key === 'ArrowRight'
				? (currentIdx + 1) % chips.length
				: (currentIdx - 1 + chips.length) % chips.length
		const next = chips[nextIdx]
		if (next) {
			next.focus()
			onTeamChange(next.dataset.team as MarketplaceTeam | 'all')
		}
	}

	return (
		<div className="mp-rail-wrap">
			<div
				className="mp-rail"
				role="tablist"
				aria-label="Filter by team"
				ref={listRef}
				onKeyDown={onKeyDown}
			>
				<span className="mp-rail-label">By team</span>
				{TEAM_LABELS.map((t) => (
					<button
						key={t.value}
						type="button"
						role="tab"
						data-team={t.value}
						aria-selected={team === t.value}
						tabIndex={team === t.value ? 0 : -1}
						className="mp-chip"
						onClick={() => onTeamChange(t.value)}
					>
						{t.label}
					</button>
				))}
			</div>
		</div>
	)
}

// ————— Bands ————— //

function AllBands({
	tab,
	bands,
	team,
	onInstall,
}: {
	tab: TabKey
	bands: {
		recommended: CatalogItemCard[]
		popular_loops: CatalogItemCard[]
		top_agents: CatalogItemCard[]
		popular_skills: CatalogItemCard[]
		most_installed_tools: CatalogItemCard[]
	}
	team: MarketplaceTeam | 'all'
	onInstall: (item: CatalogItemCard) => void
}) {
	// Recommended-band cards disappear from Recommended when installed but
	// stay in Popular per design spec.
	const recommended = bands.recommended.filter((c) => !c.installed_installation_id)

	const showRecommended = tab === 'featured'
	const showLoops = tab === 'featured' || tab === 'loops'
	const showAgents = tab === 'featured' || tab === 'agents'
	const showSkills = tab === 'featured' || tab === 'skills'
	const showTools = tab === 'featured' || tab === 'tools'

	// When a team is picked and nothing in any visible band matches, drop the
	// "Nothing tagged for X yet" empty rail per design spec.
	const anyResults =
		(showRecommended && recommended.length > 0) ||
		(showLoops && bands.popular_loops.length > 0) ||
		(showAgents && bands.top_agents.length > 0) ||
		(showSkills && bands.popular_skills.length > 0) ||
		(showTools && bands.most_installed_tools.length > 0)

	if (team !== 'all' && !anyResults) {
		return <FilterEmpty team={team} />
	}

	return (
		<>
			{showRecommended ? (
				recommended.length > 0 ? (
					<Band title="Recommended for you" note="from what your workspace already runs" seeAll>
						<div className="mp-rec-grid">
							{recommended.map((item) => (
								<RecommendedCard key={item.catalog_id} item={item} onInstall={onInstall} />
							))}
						</div>
					</Band>
				) : (
					<Band title="Recommended for you" note="from what your workspace already runs">
						<RecEmpty />
					</Band>
				)
			) : null}

			{showLoops ? (
				<Band title="Popular loops" note="installed most often this month" seeAll>
					<div className="mp-loops-grid">
						{bands.popular_loops.map((item) => (
							<LoopCard key={item.catalog_id} item={item} onInstall={onInstall} />
						))}
					</div>
				</Band>
			) : null}

			{showAgents ? (
				<Band title="Top agents" note="each owns exactly one outcome" seeAll>
					<div className="mp-compact-grid">
						{bands.top_agents.map((item) => (
							<CompactCard key={item.catalog_id} item={item} onInstall={onInstall} />
						))}
					</div>
				</Band>
			) : null}

			{showSkills ? (
				<Band title="Popular skills" note="attach to any agent" seeAll>
					<div className="mp-compact-grid">
						{bands.popular_skills.map((item) => (
							<CompactCard key={item.catalog_id} item={item} onInstall={onInstall} />
						))}
					</div>
				</Band>
			) : null}

			{showTools ? (
				<Band title="Most-installed tools" note="MCP servers, by discipline" seeAll>
					<div className="mp-compact-grid">
						{bands.most_installed_tools.map((item) => (
							<CompactCard key={item.catalog_id} item={item} onInstall={onInstall} />
						))}
					</div>
				</Band>
			) : null}
		</>
	)
}

// ————— Band shell + fallback states ————— //

function Band({
	title,
	note,
	seeAll,
	children,
}: {
	title: string
	note: string
	seeAll?: boolean
	children: React.ReactNode
}) {
	return (
		<section aria-label={title}>
			<div className="mp-band-head">
				<h2>{title}</h2>
				<span className="mp-band-note">{note}</span>
				{seeAll ? (
					<button type="button" className="mp-see-all">
						See all →
					</button>
				) : null}
			</div>
			{children}
		</section>
	)
}

function CardSkeleton() {
	return (
		<div className="mp-skel-card">
			<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
				<div className="mp-skel" style={{ width: 34, height: 34, borderRadius: 8 }} />
				<div style={{ flex: 1 }}>
					<div className="mp-skel" style={{ height: 14, width: '60%', marginBottom: 6 }} />
					<div className="mp-skel" style={{ height: 10, width: '40%' }} />
				</div>
			</div>
			<div className="mp-skel" style={{ height: 36 }} />
			<div className="mp-skel" style={{ height: 30, width: 80, marginLeft: 'auto' }} />
		</div>
	)
}

function BandError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="mp-error" role="status">
			<h3>Couldn&apos;t load the catalog</h3>
			<p>
				The catalog service is unreachable.{' '}
				<button
					type="button"
					className="mp-btn mp-btn-secondary mp-btn-sm"
					style={{ marginLeft: 6 }}
					onClick={onRetry}
				>
					Retry
				</button>
			</p>
		</div>
	)
}

function RecEmpty() {
	return (
		<div className="mp-empty" role="status">
			<h3>Nothing to recommend yet</h3>
			<p>
				Install a loop or connect an integration, and we&apos;ll suggest what pairs well. Or
				browse Popular below.
			</p>
		</div>
	)
}

function FilterEmpty({ team }: { team: MarketplaceTeam | 'all' }) {
	const label = teamLabel(team)
	return (
		<section aria-label={`${label} team`}>
			<div className="mp-band-head">
				<h2>{label} team</h2>
				<span className="mp-band-note">no items match this filter</span>
			</div>
			<div className="mp-empty" role="status">
				<h3>Nothing tagged for {label} yet</h3>
				<p>The catalog is curated per team. Try All teams or ask what belongs here.</p>
			</div>
		</section>
	)
}

// ————— Install-modal variant heuristic ————— //

function pickInitialVariant(item: CatalogItemCard): InstallModalVariant {
	if (item.requires_status === 'needs') return 'needs-integration'
	if (item.item_kind === 'loop') return 'needs-decision'
	return 'needs-decision'
}

// ————— Icons ————— //

function SearchIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<circle cx="11" cy="11" r="7" />
			<path d="M20 20l-3-3" />
		</svg>
	)
}

export type { MarketplaceItemKind }
