import { TopNav } from '@/components/layout/top-nav'
import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/lib/theme'
import { createFileRoute } from '@tanstack/react-router'
import { Layers, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Design gallery for the v2 rebuild.
 *
 * Renders every primitive that pages will compose against v2 tokens so the
 * Designer can side-by-side against `Maskin App v2 Standalone.html` and page
 * authors can verify a pattern exists before hand-rolling one. Route lives
 * under `/prototypes/*` (public, unauthenticated) to keep it off the app
 * shell and out of the sidebar.
 */
export const Route = createFileRoute('/prototypes/gallery')({
	component: GalleryPage,
})

const NEUTRAL_SWATCHES: SwatchSpec[] = [
	{ token: 'background', label: 'Background', text: 'foreground' },
	{ token: 'foreground', label: 'Foreground', text: 'background' },
	{ token: 'card', label: 'Card', text: 'card-foreground' },
	{ token: 'popover', label: 'Popover', text: 'popover-foreground' },
	{ token: 'primary', label: 'Primary', text: 'primary-foreground' },
	{ token: 'secondary', label: 'Secondary', text: 'secondary-foreground' },
	{ token: 'muted', label: 'Muted', text: 'muted-foreground' },
	{ token: 'accent', label: 'Accent', text: 'accent-foreground' },
	{ token: 'border', label: 'Border', text: 'foreground' },
	{ token: 'border-strong', label: 'Border strong', text: 'foreground' },
	{ token: 'sidebar', label: 'Sidebar', text: 'sidebar-foreground' },
]

const BRAND_SWATCHES: SwatchSpec[] = [
	{ token: 'brand', label: 'Brand', text: 'brand-foreground' },
	{ token: 'brand-hover', label: 'Brand hover', text: 'brand-foreground' },
	{ token: 'destructive', label: 'Destructive', text: 'destructive-foreground' },
	{ token: 'success', label: 'Success' },
	{ token: 'warning', label: 'Warning' },
	{ token: 'error', label: 'Error' },
]

// Every workflow status the badge library supports, so the gallery locks
// their pastels visually. Keep in sync with `statusColors` if you add one.
const STATUSES: string[] = [
	'new',
	'todo',
	'in_progress',
	'processing',
	'in_review',
	'done',
	'completed',
	'succeeded',
	'active',
	'live',
	'signal',
	'proposed',
	'clustered',
	'validated',
	'qualified',
	'define',
	'scored',
	'parked',
	'holding',
	'paused',
	'blocked',
	'failed',
	'discarded',
	'archived',
	'at_risk',
	'breached',
]

const RADII: Array<{ token: string; className: string; px: string }> = [
	{ token: '--radius-sm', className: 'rounded-sm', px: '6px' },
	{ token: '--radius-md', className: 'rounded-md', px: '8px' },
	{ token: '--radius-lg', className: 'rounded-lg', px: '10px' },
	{ token: '--radius-xl', className: 'rounded-xl', px: '14px' },
	{ token: '--radius-2xl', className: 'rounded-2xl', px: '16px' },
	{ token: '99px pill', className: 'rounded-full', px: '999px' },
]

const SHADOWS: Array<{ token: string; className: string; hint: string }> = [
	{ token: '--shadow-xs', className: 'shadow-xs', hint: 'flush controls' },
	{ token: '--shadow-sm', className: 'shadow-sm', hint: 'card at rest' },
	{ token: '--shadow-md', className: 'shadow-md', hint: 'hover / lift' },
	{ token: '--shadow-lg', className: 'shadow-lg', hint: 'dropdown, popover' },
	{ token: '--shadow-xl', className: 'shadow-xl', hint: 'modal, overlay' },
]

const TYPE_SCALE: Array<{
	step: string
	className: string
	specimen: string
	role: string
}> = [
	{
		step: 'page title',
		className: 'text-2xl font-semibold tracking-[-0.022em]',
		specimen: 'Rebuild the app front end',
		role: 'One per page',
	},
	{
		step: 'section',
		className: 'text-lg font-medium tracking-[-0.013em]',
		specimen: 'Design tokens',
		role: 'Major section headers',
	},
	{
		step: 'body',
		className: 'text-sm font-normal',
		specimen: 'Every visual value on every page resolves to a token.',
		role: 'Default body + prose',
	},
	{
		step: 'label',
		className: 'text-xs font-medium',
		specimen: 'Owner',
		role: 'Form labels, metadata',
	},
	{
		step: 'caption',
		className: 'text-xs font-normal',
		specimen: 'Uploaded 3 minutes ago',
		role: 'Helper text, timestamps',
	},
]

function GalleryPage() {
	const { theme, setTheme, resolvedTheme } = useTheme()

	return (
		<div className="min-h-screen bg-background text-foreground">
			<TopNav
				tabs={[
					{ key: 'design', label: 'Design system', active: true },
					{ key: 'motion', label: 'Motion' },
					{ key: 'copy', label: 'Copy' },
				]}
				activeTabKey="design"
				filters={[
					{ key: 'tokens', label: 'Tokens', count: 3 },
					{ key: 'primitives', label: 'Primitives', count: 6 },
					{ key: 'patterns', label: 'Patterns', count: 4 },
				]}
				menuLabel={themeMenuLabel(theme)}
				menuIcon={themeMenuIcon(resolvedTheme)}
				onMenuClick={() =>
					setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')
				}
				trailing={
					<Button size="sm" className="h-[30px] rounded-lg text-[12px] font-semibold">
						New
					</Button>
				}
			/>

			<div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 px-6 pb-24 pt-6">
				<header>
					<div className="eyebrow">v2 design system</div>
					<h1 className="mt-2 text-2xl font-semibold tracking-[-0.022em]">Gallery</h1>
					<p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
						The buildable inventory that every restyle task must render from. Source of truth:{' '}
						<code className="font-mono text-[12.5px]">Maskin App v2 Standalone.html</code>. No page
						may ship a colour, radius, shadow, or font this doc doesn't own.
					</p>
				</header>

				<Section
					eyebrow="Tokens · Palette"
					title="Colour"
					lead="Neutrals, brand, and semantic tones. Every raw hex lives in app.css — never in a component."
				>
					<SwatchGrid title="Neutral surface + text" swatches={NEUTRAL_SWATCHES} />
					<SwatchGrid title="Brand + semantic" swatches={BRAND_SWATCHES} />
				</Section>

				<Section
					eyebrow="Tokens · Type"
					title="Typography"
					lead="Schibsted Grotesk (sans) + JetBrains Mono (mono), self-hosted from /fonts/. Five-step ramp."
				>
					<div className="overflow-hidden rounded-xl border border-border">
						{TYPE_SCALE.map((row, idx) => (
							<div
								key={row.step}
								className={`grid grid-cols-1 gap-3 border-border px-5 py-4 md:grid-cols-[8rem_1fr_10rem] md:items-baseline ${
									idx === 0 ? '' : 'border-t'
								}`}
							>
								<div className="eyebrow">{row.step}</div>
								<div className={row.className}>{row.specimen}</div>
								<div className="font-mono text-[11px] text-muted-foreground">{row.role}</div>
							</div>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						Mono numerals are tabular by default via <code>font-variant-numeric</code>.
					</p>
				</Section>

				<Section
					eyebrow="Tokens · Shape"
					title="Radii + shadows"
					lead="Base radius 10px. Shadows step from resting card to modal."
				>
					<div className="grid gap-3 md:grid-cols-3">
						{RADII.map((r) => (
							<div
								key={r.token}
								className="flex items-center gap-4 rounded-lg border border-border bg-card p-3"
							>
								<div className={`h-12 w-12 bg-primary ${r.className}`} />
								<div>
									<div className="text-xs font-semibold">{r.token}</div>
									<div className="font-mono text-[11px] text-muted-foreground">{r.px}</div>
								</div>
							</div>
						))}
					</div>
					<div className="mt-6 grid gap-4 md:grid-cols-5">
						{SHADOWS.map((s) => (
							<div
								key={s.token}
								className={`flex flex-col gap-2 rounded-xl border border-border bg-card p-4 ${s.className}`}
							>
								<div className="text-xs font-semibold">{s.token}</div>
								<div className="text-[11px] text-muted-foreground">{s.hint}</div>
							</div>
						))}
					</div>
				</Section>

				<Section
					eyebrow="Primitives · Buttons"
					title="Buttons"
					lead="shadcn Button variants against v2 tokens. Sizes stay untouched."
				>
					<div className="flex flex-wrap items-center gap-3">
						<Button>Default</Button>
						<Button variant="secondary">Secondary</Button>
						<Button variant="outline">Outline</Button>
						<Button variant="ghost">Ghost</Button>
						<Button variant="destructive">Destructive</Button>
						<Button variant="link">Link</Button>
					</div>
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<Button size="sm">Small</Button>
						<Button>Default</Button>
						<Button size="lg">Large</Button>
						<Button size="icon" aria-label="Layers">
							<Layers />
						</Button>
					</div>
				</Section>

				<Section
					eyebrow="Primitives · Badges + chips"
					title="Badges, status, chips"
					lead="StatusBadge and TypeBadge stay first-class. Chips (filter/count) come from the shared library."
				>
					<div className="flex flex-wrap items-center gap-2">
						<Badge>Default</Badge>
						<Badge variant="secondary">Secondary</Badge>
						<Badge variant="outline">Outline</Badge>
						<Badge variant="ghost">Ghost</Badge>
						<Badge variant="destructive">Destructive</Badge>
					</div>
					<div className="mt-4 flex flex-wrap items-center gap-2">
						{['insight', 'bet', 'task'].map((t) => (
							<TypeBadge key={t} type={t} />
						))}
						{['insight', 'bet', 'task'].map((t) => (
							<TypeBadge key={`${t}-mono`} type={t} variant="mono" />
						))}
					</div>
					<div className="mt-4 grid grid-cols-2 gap-1.5 md:grid-cols-4">
						{STATUSES.map((s) => (
							<StatusBadge key={s} status={s} />
						))}
					</div>
					<div className="mt-4 flex flex-wrap items-center gap-2 text-[11.5px] font-semibold">
						{/* Toolbar chips — same shape as the TopNav filter chips above.
						    Not re-imported from TopNav because gallery specimens
						    render plain (no click behaviour), and shared/filter-chip
						    is the removable-filter pattern, a different use case. */}
						<span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-strong bg-secondary px-3 text-foreground">
							All <span className="text-[10.5px] text-border-strong">128</span>
						</span>
						{[
							['Bets', 12],
							['Tasks', 64],
							['Insights', 52],
						].map(([label, count]) => (
							<span
								key={label as string}
								className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-muted-foreground"
							>
								{label} <span className="text-[10.5px] text-border-strong">{count}</span>
							</span>
						))}
					</div>
				</Section>

				<Section
					eyebrow="Primitives · Inputs"
					title="Form controls"
					lead="Input, label, and skeleton. Selects live in shadcn's Select — use it directly, don't reimplement."
				>
					<div className="grid gap-4 md:grid-cols-2">
						<div>
							<Label htmlFor="specimen-input">Owner</Label>
							<Input id="specimen-input" placeholder="Search actors…" className="mt-2" />
						</div>
						<div className="flex flex-col gap-2">
							<Label>Skeletons</Label>
							<Skeleton className="h-4 w-3/4" />
							<Skeleton className="h-4 w-1/2" />
							<Skeleton className="h-4 w-2/3" />
						</div>
					</div>
				</Section>

				<Section
					eyebrow="Patterns · Cards"
					title="Cards, empty states, loading"
					lead="The card pattern the Objects list and For-you feed both compose against."
				>
					<div className="grid gap-4 md:grid-cols-2">
						<Card>
							<CardHeader>
								<CardTitle>Objects list row</CardTitle>
								<CardDescription>
									Compact card used by list surfaces to hold a title, chips, and trailing metadata.
								</CardDescription>
							</CardHeader>
							<CardContent className="flex items-center justify-between gap-3">
								<span className="text-sm">Rebuild the app front end</span>
								<div className="flex items-center gap-2">
									<StatusBadge status="active" />
									<TypeBadge type="bet" variant="mono" />
								</div>
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle>Loading state</CardTitle>
								<CardDescription>Skeleton + inline spinner.</CardDescription>
							</CardHeader>
							<CardContent className="flex items-center gap-3">
								<Spinner />
								<Skeleton className="h-4 flex-1" />
							</CardContent>
						</Card>
					</div>
					<EmptyState
						title="No bets yet"
						description="When a strategist opens a bet, it lands here."
					/>
				</Section>

				<Section
					eyebrow="Patterns · Menus"
					title="Menu specimen"
					lead="The eyebrow-labelled sections match the mockup's VIEW / SHOW / SORT menu blocks."
				>
					<div className="rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg md:w-[264px]">
						<div className="eyebrow px-2.5 pb-1 pt-2">View</div>
						<MenuItem label="List" trailing="✓" />
						<MenuItem label="Board" />
						<MenuItem label="Filter pills" trailing="✓" />
						<div className="my-1 h-px bg-border" />
						<div className="eyebrow px-2.5 pb-1 pt-2">Show</div>
						<MenuItem label="All objects" count={128} trailing="✓" />
						<MenuItem label="Bets" count={12} />
						<MenuItem label="Tasks" count={64} />
						<div className="my-1 h-px bg-border" />
						<div className="eyebrow px-2.5 pb-1 pt-2">Sort</div>
						<MenuItem label="Updated" trailing="✓" />
						<MenuItem label="Created" />
					</div>
				</Section>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Local presentational helpers used only inside the gallery. Kept co-located
// because they carry no behaviour beyond visual arrangement — they aren't
// re-used elsewhere and don't belong in the shared library.
// ---------------------------------------------------------------------------

interface SwatchSpec {
	token: string
	label: string
	text?: string
}

function SwatchGrid({ title, swatches }: { title: string; swatches: SwatchSpec[] }) {
	return (
		<div>
			<div className="mb-3 text-xs font-semibold text-muted-foreground">{title}</div>
			<div className="grid grid-cols-2 gap-2 md:grid-cols-4">
				{swatches.map((s) => (
					<div
						key={s.token}
						className="flex flex-col overflow-hidden rounded-xl border border-border"
					>
						<div
							className="flex h-16 items-end justify-start p-2 text-[11px] font-semibold"
							style={{
								backgroundColor: `var(--${s.token})`,
								color: s.text ? `var(--${s.text})` : undefined,
							}}
						>
							{s.label}
						</div>
						<div className="bg-card px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
							--{s.token}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

function Section({
	eyebrow,
	title,
	lead,
	children,
}: {
	eyebrow: string
	title: string
	lead?: string
	children: ReactNode
}) {
	return (
		<section className="flex flex-col gap-4">
			<header className="flex flex-col gap-1">
				<div className="eyebrow">{eyebrow}</div>
				<h2 className="text-lg font-medium tracking-[-0.013em]">{title}</h2>
				{lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
			</header>
			{children}
		</section>
	)
}

function MenuItem({
	label,
	count,
	trailing,
}: {
	label: string
	count?: number
	trailing?: string
}) {
	return (
		<div className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent">
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{typeof count === 'number' ? (
				<span className="text-[10.5px] font-semibold text-border-strong">{count}</span>
			) : null}
			<span className="w-[13px] text-[11px] text-foreground">{trailing ?? ''}</span>
		</div>
	)
}

function themeMenuLabel(theme: string) {
	if (theme === 'light') return 'Theme · Light'
	if (theme === 'dark') return 'Theme · Dark'
	return 'Theme · System'
}

function themeMenuIcon(resolved: 'light' | 'dark') {
	if (resolved === 'dark') return <Moon aria-hidden="true" className="size-[13px]" />
	return <Sun aria-hidden="true" className="size-[13px]" />
}
