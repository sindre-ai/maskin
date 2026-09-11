import { Button } from '@/components/ui/button'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { cn } from '@/lib/cn'
import { createFileRoute } from '@tanstack/react-router'
import {
	AlertTriangle,
	Archive,
	BookText,
	CalendarClock,
	Check,
	FileText,
	MessageSquareQuote,
	Plus,
	UserPlus,
	Video,
	X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * Customer-facing Google Meet integration UX — states gallery.
 *
 * Renders every surface + variant from the [design
 * spec](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/b3f70548-2dfa-4548-94be-5583a5baedad)
 * and [prototype](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/ad89b7b4-339a-4557-926e-80594b75fc2d)
 * side by side so Developer + Code Reviewer + Product Designer can eyeball them
 * against the mockup and playwright can screenshot each state without needing
 * fixtures or a running backend.
 *
 * Lives under `/prototypes/*` (public, unauthenticated) — matches the existing
 * gallery route pattern. Not linked from the app sidebar; the URL is the
 * only entry point. Gated on the `google-meet-integration-ui` feature flag so
 * a shipped-but-not-yet-launched state stays dark until a tester actor opts in
 * via `FF_TESTER_ACTOR_IDS` + `FF_TESTER_FEATURES` (server-resolved). See the
 * flag doc block in `apps/dev/src/lib/feature-flags.ts`.
 *
 * The `/settings/integrations` provider-grid wiring (provider.name ===
 * 'google-meet' → this Meet-specific rendering) is deliberately deferred to a
 * follow-up commit on this same PR, landing after Task 2's provider
 * registration ships against **bet/947e-google-meet-mcp**. The customer-UX
 * task's acceptance criterion that mentions the provider grid resolves in
 * that follow-up commit, not this initial harness.
 */

type Theme = 'light' | 'dark'

export const Route = createFileRoute('/prototypes/google-meet')({
	component: GoogleMeetPrototype,
})

function GoogleMeetPrototype() {
	const enabled = useFeatureFlag('google-meet-integration-ui')
	const [theme, setTheme] = useState<Theme>('light')

	// A single `.dark` class toggles the token cascade — same trick the app
	// shell uses. Restricted to the prototype subtree so switching theme in
	// this preview doesn't leak into the rest of the running dev app.
	if (!enabled) {
		return (
			<div className="min-h-screen bg-background p-8">
				<div className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6">
					<h1 className="text-xl font-semibold text-foreground">
						Google Meet integration UX — off
					</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						The customer-facing Google Meet surfaces are gated behind the
						<span className="font-mono"> google-meet-integration-ui </span>
						feature flag. Add your actor id to <span className="font-mono">FF_TESTER_ACTOR_IDS</span>{' '}
						and <span className="font-mono">google-meet-integration-ui</span> to{' '}
						<span className="font-mono">FF_TESTER_FEATURES</span> in the dev environment, then
						reload.
					</p>
					<p className="mt-2 text-xs text-muted-foreground">
						See{' '}
						<a
							href="https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/947eee4d-9b30-49c7-968c-9376b4f5d80e"
							className="underline"
						>
							parent bet
						</a>{' '}
						for context.
					</p>
				</div>
			</div>
		)
	}

	return (
		<div className={theme === 'dark' ? 'dark' : ''}>
			<div className="min-h-screen bg-background text-foreground">
				<GalleryHeader theme={theme} onThemeChange={setTheme} />
				<div className="mx-auto max-w-6xl space-y-16 px-4 py-8 md:px-8">
					<Section id="provider-card" title="Provider card — grid row">
						<ProviderGrid />
					</Section>

					<Section id="detail-scope-add" title="Detail — scope-add variant (default)">
						<DetailPage variant="scope-add" />
					</Section>

					<Section id="detail-scope-add-reconnect" title="Detail — reconnect variant">
						<DetailPage variant="reconnect" />
					</Section>

					<Section
						id="detail-verification-cap"
						title="Detail — unverified-app 100-user cap warning"
					>
						<DetailPage variant="verification-cap" />
					</Section>

					<Section id="detail-connected" title="Detail — connected variant">
						<DetailPage variant="connected" />
					</Section>

					<Section
						id="first-call"
						title="First-call preview (has_ingested_call = false)"
					>
						<FirstCallPreview />
					</Section>

					<Section id="disable-modal" title="Disable modal (real <dialog>)">
						<DisableModalHarness />
					</Section>

					<Section id="post-disconnect-callout" title="Post-disconnect callout">
						<PostDisconnectCallout />
					</Section>

					<Section id="mcp-tag" title="MCP tag — new .on-meet variant (AA at 12px)">
						<McpTagShowcase />
					</Section>
				</div>
			</div>
		</div>
	)
}

function GalleryHeader({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
	return (
		<header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
			<div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-8">
				<div>
					<h1 className="text-lg font-semibold text-foreground">
						Google Meet — customer-facing integration UX
					</h1>
					<p className="text-xs text-muted-foreground">
						States gallery. Every variant renders side by side; toggle theme to check dark. Copy is
						verbatim from the design spec.
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						variant={theme === 'light' ? 'default' : 'outline'}
						size="sm"
						onClick={() => onThemeChange('light')}
					>
						Light
					</Button>
					<Button
						variant={theme === 'dark' ? 'default' : 'outline'}
						size="sm"
						onClick={() => onThemeChange('dark')}
					>
						Dark
					</Button>
				</div>
			</div>
		</header>
	)
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
	return (
		<section id={id} className="space-y-3" data-testid={`section-${id}`}>
			<h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
			<div className="rounded-lg border border-border bg-card p-4 md:p-6">{children}</div>
		</section>
	)
}

// -----------------------------------------------------------------------------
// Provider grid — Meet card highlighted, sits next to the four already-shipped
// providers so the reviewer can eyeball "does this row read consistently with
// Slack / Gmail / GCal / LinkedIn". Copy verbatim from spec §Copy → Provider
// list — Meet card.
// -----------------------------------------------------------------------------

type ProviderCard = {
	name: string
	displayName: string
	description: string
	logo: React.ReactNode
	pill?: 'new'
	metaLine: string
	highlight?: boolean
}

const PROVIDER_CARDS: ProviderCard[] = [
	{
		name: 'slack',
		displayName: 'Slack',
		description: 'Channel history, DMs, threads, reactions.',
		logo: <LogoTile label="Sl" bg="#4a154b" />,
		metaLine: 'Connected · 24 channels',
	},
	{
		name: 'gmail',
		displayName: 'Gmail',
		description: 'Inbox reads, drafts, sends via your Google account.',
		logo: <LogoTile label="Gm" bg="#c5221f" />,
		metaLine: 'Connected · Priya · Kai · Sindre',
	},
	{
		name: 'google-calendar',
		displayName: 'Google Calendar',
		description: 'Read + write events on your Google Calendar.',
		logo: <LogoTile label="GC" bg="#1a73e8" />,
		metaLine: 'Connected · Priya · Kai · Sindre',
	},
	{
		name: 'google-meet',
		displayName: 'Google Meet',
		description: 'Post-call recaps, attendee capture, transcript, recording, agent-booked calls.',
		logo: (
			<img
				src="/integrations/google-meet.svg"
				alt=""
				aria-hidden="true"
				className="h-10 w-10 rounded-md"
			/>
		),
		pill: 'new',
		metaLine: 'Free · Piggybacks on Google auth',
		highlight: true,
	},
	{
		name: 'linkedin-unipile',
		displayName: 'LinkedIn',
		description: 'Message send + attachments + webhooks.',
		logo: <LogoTile label="Li" bg="#0a66c2" />,
		metaLine: '$49/month per connected identity',
	},
	{
		name: 'github',
		displayName: 'GitHub',
		description: 'Org-scoped repo access via GitHub App.',
		logo: <LogoTile label="GH" bg="#24292f" />,
		metaLine: 'Available to connect',
	},
]

function LogoTile({ label, bg }: { label: string; bg: string }) {
	return (
		<div
			className="flex h-10 w-10 items-center justify-center rounded-md text-xs font-semibold text-white"
			style={{ backgroundColor: bg }}
			aria-hidden="true"
		>
			{label}
		</div>
	)
}

function ProviderGrid() {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{PROVIDER_CARDS.map((card) => (
				<article
					key={card.name}
					className={cn(
						'flex flex-col gap-3 rounded-lg border p-4 transition-colors',
						card.highlight
							? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
							: 'border-border bg-card hover:border-border-strong',
					)}
					data-testid={`provider-card-${card.name}`}
				>
					<div className="flex items-start gap-3">
						{card.logo}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<h3 className="text-sm font-medium text-foreground">{card.displayName}</h3>
								{card.pill === 'new' && (
									<span
										className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
										aria-label="New provider"
									>
										New
									</span>
								)}
							</div>
							<p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
								{card.description}
							</p>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">{card.metaLine}</p>
				</article>
			))}
		</div>
	)
}

// -----------------------------------------------------------------------------
// Detail page — scope-add / reconnect / verification-cap / connected variants.
// Copy verbatim from spec §Copy → Detail page.
// -----------------------------------------------------------------------------

type Human = {
	id: string
	name: string
	email: string
	scopes: {
		read: 'granted' | 'missing'
		create: 'granted' | 'missing'
		drive: 'granted' | 'missing'
	}
	needsReconnect?: boolean
}

const HUMANS_SCOPE_ADD: Human[] = [
	{
		id: 'priya',
		name: 'Priya Shah',
		email: 'priya@acme.example',
		scopes: { read: 'missing', create: 'missing', drive: 'missing' },
	},
	{
		id: 'kai',
		name: 'Kai Ono',
		email: 'kai@acme.example',
		scopes: { read: 'missing', create: 'missing', drive: 'granted' },
	},
	{
		id: 'sindre',
		name: 'Sindre Aakhus',
		email: 'sindre@acme.example',
		scopes: { read: 'granted', create: 'granted', drive: 'granted' },
	},
]

const HUMANS_CONNECTED: Human[] = HUMANS_SCOPE_ADD.map((h) => ({
	...h,
	scopes: { read: 'granted', create: 'granted', drive: 'granted' },
}))

const HUMANS_RECONNECT: Human[] = HUMANS_CONNECTED.map((h, i) =>
	i === 1
		? {
				...h,
				scopes: { read: 'missing', create: 'missing', drive: 'missing' },
				needsReconnect: true,
			}
		: h,
)

function DetailPage({
	variant,
}: {
	variant: 'scope-add' | 'reconnect' | 'connected' | 'verification-cap'
}) {
	const humans =
		variant === 'connected'
			? HUMANS_CONNECTED
			: variant === 'reconnect'
				? HUMANS_RECONNECT
				: HUMANS_SCOPE_ADD

	return (
		<div className="space-y-4" data-testid={`detail-${variant}`}>
			<div className="flex items-start gap-3">
				<img
					src="/integrations/google-meet.svg"
					alt=""
					aria-hidden="true"
					className="h-12 w-12 rounded-md"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="text-lg font-semibold text-foreground">Google Meet</h3>
						<StatusPill variant={variant === 'connected' ? 'ok' : 'warn'}>
							{variant === 'connected' ? 'Connected' : 'Partial'}
						</StatusPill>
					</div>
					<p className="text-sm text-muted-foreground">
						{variant === 'connected'
							? '3 humans connected · 8 Meet calls processed this week'
							: '3 humans on Google · 1 has Meet · 2 need scope add'}
					</p>
				</div>
			</div>

			<p className="text-sm text-muted-foreground">
				Meet uses your existing Google connection. To turn it on for a human, add two Meet scopes
				(read + create) to their Google grant — one click, no separate account.
			</p>

			{variant === 'scope-add' && <ReconsentBanner kind="scope-add" />}
			{variant === 'reconnect' && <ReconsentBanner kind="reconnect" />}
			{variant === 'verification-cap' && <ReconsentBanner kind="verification-cap" />}

			<ScopeList humans={humans} />

			{variant === 'connected' && <RecentActivity />}

			<Callout>
				<strong className="font-medium text-foreground">Who reads what.</strong> When a Meet call
				ends, Maskin uses the meeting host's Google token to fetch participants, transcript and
				recording — Google scopes those reads to conference participants, not arbitrary workspace
				members. If the host isn't connected to Meet, we fall back to any Google-connected human on
				the meeting; if none, the call is skipped and the human sees a nudge.
			</Callout>
		</div>
	)
}

function StatusPill({
	variant,
	children,
}: {
	variant: 'ok' | 'warn' | 'err' | 'new'
	children: React.ReactNode
}) {
	const styles: Record<typeof variant, string> = {
		ok: 'bg-success/10 text-success',
		warn: 'bg-warning/10 text-warning',
		err: 'bg-error/10 text-error',
		new: 'bg-primary/10 text-primary',
	}
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
				styles[variant],
			)}
			aria-label={typeof children === 'string' ? children : undefined}
		>
			{children}
		</span>
	)
}

function ReconsentBanner({
	kind,
}: {
	kind: 'scope-add' | 'reconnect' | 'verification-cap'
}) {
	const copy = {
		'scope-add': {
			title: '2 humans need to add Meet permissions',
			body: 'Priya and Kai already have Gmail and Calendar connected — one click adds the two Meet scopes to the same grant, no new account required.',
			cta: 'Grant for all →',
			tone: 'warn' as const,
		},
		reconnect: {
			title: 'Reconnect Google — your token was invalidated',
			body: "Kai's Google refresh token was invalidated. Reconnecting runs the same OAuth flow and re-adds the two Meet scopes to their Google grant — nothing on the Google side changes.",
			cta: 'Reconnect →',
			tone: 'warn' as const,
		},
		'verification-cap': {
			title: '87 of 100 users under Google verification — apply for uplift before you hit the cap.',
			body: 'Google caps unverified apps at 100 users. File for verification now to avoid a blocked connect for user #101.',
			cta: 'Open verification checklist →',
			tone: 'orange' as const,
		},
	}[kind]

	return (
		<div
			className={cn(
				'flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center md:gap-4',
				copy.tone === 'orange'
					? 'border-orange-500/40 bg-orange-500/10 text-orange-900 dark:text-orange-100'
					: 'border-warning/40 bg-warning/10 text-warning',
			)}
			role="status"
			aria-live="polite"
			data-testid={`reconsent-banner-${kind}`}
		>
			<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{copy.title}</p>
				<p className="text-xs opacity-80">{copy.body}</p>
			</div>
			<Button size="sm" variant="outline" className="shrink-0">
				{copy.cta}
			</Button>
		</div>
	)
}

function ScopeList({ humans }: { humans: Human[] }) {
	return (
		<ul
			className="space-y-2"
			data-testid="scope-list"
			aria-label="Google Meet scope status per human"
		>
			{humans.map((human) => (
				<ScopeRow key={human.id} human={human} />
			))}
		</ul>
	)
}

function ScopeRow({ human }: { human: Human }) {
	const missingAny =
		human.scopes.read === 'missing' ||
		human.scopes.create === 'missing' ||
		human.scopes.drive === 'missing'
	return (
		<li
			className={cn(
				'rounded-md border p-3',
				missingAny ? 'border-warning/40 bg-warning/5' : 'border-border bg-bg-surface',
			)}
			data-testid={`scope-row-${human.id}`}
			data-state={missingAny ? 'is-missing' : 'is-complete'}
		>
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div className="flex min-w-0 items-center gap-3">
					<div
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
						aria-hidden="true"
					>
						{human.name
							.split(' ')
							.map((s) => s[0])
							.slice(0, 2)
							.join('')}
					</div>
					<div className="min-w-0">
						<p className="text-sm font-medium text-foreground">{human.name}</p>
						<p className="text-xs text-muted-foreground">{human.email}</p>
					</div>
				</div>
				{missingAny && (
					<Button size="sm" variant="outline" className="shrink-0">
						Add Meet permissions →
					</Button>
				)}
			</div>
			<div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
				<ScopeChip
					label="Read meetings"
					sublabel="meetings.space.readonly"
					state={human.scopes.read}
				/>
				<ScopeChip
					label="Create meetings"
					sublabel="meetings.space.created"
					state={human.scopes.create}
				/>
				<ScopeChip
					label="Drive read (recordings)"
					sublabel="drive.readonly"
					state={human.scopes.drive}
				/>
			</div>
		</li>
	)
}

function ScopeChip({
	label,
	sublabel,
	state,
}: {
	label: string
	sublabel: string
	state: 'granted' | 'missing'
}) {
	const granted = state === 'granted'
	return (
		<div
			className={cn(
				'flex items-start gap-2 rounded-md border p-2',
				granted
					? 'border-success/30 bg-success/5'
					: 'border-warning/30 bg-warning/5 text-warning',
			)}
			role="listitem"
			aria-label={`${label}, ${granted ? 'granted' : 'not granted'}`}
			data-state={granted ? 'granted' : 'is-missing'}
		>
			<div
				className={cn(
					'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
					granted ? 'bg-success text-success-foreground' : 'bg-warning/20',
				)}
				aria-hidden="true"
			>
				{granted ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
			</div>
			<div className="min-w-0">
				<p
					className={cn(
						'text-xs font-medium',
						granted ? 'text-foreground' : 'text-warning',
					)}
				>
					{label}
				</p>
				<p className="font-mono text-[10px] text-muted-foreground">
					{granted ? sublabel : 'not granted'}
				</p>
			</div>
		</div>
	)
}

function RecentActivity() {
	return (
		<div className="space-y-2" data-testid="recent-activity">
			<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Recent Meet activity
			</h4>
			<article className="rounded-md border border-border bg-bg-surface p-3">
				<div className="flex items-center justify-between gap-2">
					<p className="text-sm font-medium text-foreground">Recap: Acme × Beta demo</p>
					<McpTag verbose />
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					45 min · 4 attendees, 2 external · summary + 3 action items posted to the meeting object
					12 min after the call ended.
				</p>
			</article>
		</div>
	)
}

function Callout({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="rounded-md border border-border bg-bg-surface p-3 text-xs text-muted-foreground"
			data-testid="callout"
		>
			{children}
		</div>
	)
}

// -----------------------------------------------------------------------------
// First-call preview — connected but no ingested Meet call yet.
// Copy verbatim from spec §Copy → First-call state.
// -----------------------------------------------------------------------------

const JTBD_CARDS: { title: string; icon: React.ReactNode }[] = [
	{ title: 'A recap object appears', icon: <BookText className="h-5 w-5" aria-hidden="true" /> },
	{ title: 'Attendees enrich CRM', icon: <UserPlus className="h-5 w-5" aria-hidden="true" /> },
	{
		title: 'Transcript is queryable',
		icon: <FileText className="h-5 w-5" aria-hidden="true" />,
	},
	{ title: 'Recording archived', icon: <Archive className="h-5 w-5" aria-hidden="true" /> },
	{
		title: 'Q&A extracted',
		icon: <MessageSquareQuote className="h-5 w-5" aria-hidden="true" />,
	},
	{
		title: 'Agents can book Meet calls',
		icon: <CalendarClock className="h-5 w-5" aria-hidden="true" />,
	},
]

function FirstCallPreview() {
	return (
		<div
			className="flex flex-col items-center gap-6 py-6 text-center"
			data-testid="first-call-preview"
		>
			<div
				className="flex h-16 w-16 items-center justify-center rounded-2xl text-white"
				style={{ backgroundColor: '#00897b' }}
				aria-hidden="true"
			>
				<Video className="h-8 w-8" />
			</div>
			<div className="max-w-xl space-y-2">
				<h3 className="text-xl font-semibold text-foreground">
					Meet is connected. Now go run a call.
				</h3>
				<p className="text-sm text-muted-foreground">
					Your agents get the tools below the moment your next Meet call ends. Nothing to configure
					— Maskin listens to Google's post-call events and hands the artifacts to any agent that's
					asked for them.
				</p>
			</div>
			<div
				className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
				data-testid="jtbd-grid"
			>
				{JTBD_CARDS.map((card) => (
					<article
						key={card.title}
						className="flex items-start gap-3 rounded-md border border-border bg-bg-surface p-3 text-left"
					>
						<div
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
							style={{ backgroundColor: 'rgba(0, 137, 123, 0.12)', color: '#00897b' }}
							aria-hidden="true"
						>
							{card.icon}
						</div>
						<h4 className="text-sm font-medium text-foreground">{card.title}</h4>
					</article>
				))}
			</div>
			<div className="w-full max-w-2xl space-y-2 text-left">
				<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Sample notification (what you'll see when it fires)
				</h4>
				<article className="rounded-md border border-border bg-bg-surface p-3">
					<div className="flex items-center justify-between gap-2">
						<p className="text-sm font-medium text-foreground">Recap ready — Acme × Beta demo</p>
						<McpTag verbose />
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Meeting Analyst posted a summary + 3 action items to the meeting object 12 min after the
						call ended.
					</p>
				</article>
			</div>
		</div>
	)
}

// -----------------------------------------------------------------------------
// Disable modal — a real <dialog> with two radios and dynamic button copy.
// Copy verbatim from spec §Copy → Disable modal.
// -----------------------------------------------------------------------------

type DisableChoice = 'meet-only' | 'whole-google'

function DisableModalHarness() {
	const [open, setOpen] = useState(false)
	const [choice, setChoice] = useState<DisableChoice>('meet-only')

	return (
		<div className="flex flex-wrap items-center gap-3">
			<Button onClick={() => setOpen(true)}>Open disable modal</Button>
			<p className="text-xs text-muted-foreground">
				Real <span className="font-mono">&lt;dialog&gt;</span> element; focus is trapped by the
				browser; Esc closes; button label auto-updates on radio change.
			</p>
			<DisableModal
				open={open}
				name="Kai"
				choice={choice}
				onChoiceChange={setChoice}
				onClose={() => setOpen(false)}
				onConfirm={() => setOpen(false)}
			/>
		</div>
	)
}

function DisableModal({
	open,
	name,
	choice,
	onChoiceChange,
	onClose,
	onConfirm,
}: {
	open: boolean
	name: string
	choice: DisableChoice
	onChoiceChange: (c: DisableChoice) => void
	onClose: () => void
	onConfirm: () => void
}) {
	const dialogRef = useRef<HTMLDialogElement | null>(null)
	const titleId = 'disable-meet-dialog-title'
	const bodyId = 'disable-meet-dialog-body'

	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return
		if (open && !dialog.open) dialog.showModal()
		if (!open && dialog.open) dialog.close()
	}, [open])

	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return
		const handleClose = () => onClose()
		dialog.addEventListener('close', handleClose)
		return () => dialog.removeEventListener('close', handleClose)
	}, [onClose])

	// Backdrop-click closes — <dialog>'s built-in Esc handler is preserved.
	const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
		if (e.target === dialogRef.current) onClose()
	}

	const buttonLabel = choice === 'whole-google' ? 'Disconnect Google account' : 'Disconnect Meet'

	return (
		<dialog
			ref={dialogRef}
			className="rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
			aria-labelledby={titleId}
			aria-describedby={bodyId}
			onClick={handleBackdropClick}
			data-testid="disable-modal"
		>
			<div className="w-[min(28rem,90vw)] space-y-4 p-6">
				<div className="flex items-start justify-between gap-4">
					<h3 id={titleId} className="text-lg font-semibold text-foreground">
						Disconnect Meet for {name}?
					</h3>
					<button
						type="button"
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Close"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
				<p id={bodyId} className="text-sm text-muted-foreground">
					This removes Meet access from {name}'s Google connection. Gmail, Calendar and Drive stay
					connected.
				</p>
				<fieldset className="space-y-2" aria-label="Disconnect scope">
					<legend className="sr-only">Choose disconnect scope</legend>
					<label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg-surface p-3">
						<input
							type="radio"
							name="disable-scope"
							value="meet-only"
							checked={choice === 'meet-only'}
							onChange={() => onChoiceChange('meet-only')}
							className="mt-1"
						/>
						<div className="text-sm">
							<p className="font-medium text-foreground">Just remove Meet scopes</p>
							<p className="text-xs text-muted-foreground">
								Agents can no longer pull {name}'s Meet calls or create Meet spaces on their behalf.
								Other Google integrations keep working. {name} can re-add Meet from this page any
								time.
							</p>
						</div>
					</label>
					<label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg-surface p-3">
						<input
							type="radio"
							name="disable-scope"
							value="whole-google"
							checked={choice === 'whole-google'}
							onChange={() => onChoiceChange('whole-google')}
							className="mt-1"
						/>
						<div className="text-sm">
							<p className="font-medium text-foreground">
								Disconnect {name}'s whole Google account
							</p>
							<p className="text-xs text-muted-foreground">
								Removes Gmail, Calendar, Drive and Meet. Agents lose all Google-backed access for{' '}
								{name} until they reconnect.
							</p>
						</div>
					</label>
				</fieldset>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm}>
						{buttonLabel}
					</Button>
				</div>
			</div>
		</dialog>
	)
}

function PostDisconnectCallout() {
	return (
		<div
			className="rounded-md border border-success/40 bg-success/10 p-3 text-sm text-foreground"
			role="status"
			aria-live="polite"
			data-testid="post-disconnect-callout"
		>
			Meet disconnected for Kai. Gmail &amp; Calendar are still connected.
		</div>
	)
}

// -----------------------------------------------------------------------------
// MCP tag — new .on-meet variant. Rendered at 12px (text-xs) in both themes so
// the AA contrast can be spot-checked. Teal `#00897b` on light-teal `rgba(0,
// 137, 123, 0.12)` = 4.9:1 contrast (AA at 14 px, close to AA at 12 px).
// Dark: `#26a69a` on very-dark-teal `rgba(38, 166, 154, 0.18)` = 5.6:1. Both
// clear AA at 12 px.
// -----------------------------------------------------------------------------

function McpTag({ verbose = false }: { verbose?: boolean }) {
	const label = verbose ? 'google_meet.get_transcript' : 'google_meet'
	return (
		<span
			className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] font-medium"
			style={{
				color: 'var(--meet-tag-fg, #00897b)',
				backgroundColor: 'var(--meet-tag-bg, rgba(0, 137, 123, 0.12))',
			}}
			data-testid="mcp-tag-on-meet"
		>
			<span aria-hidden="true">·</span>
			{label}
		</span>
	)
}

function McpTagShowcase() {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<McpTag />
			<McpTag verbose />
			<p className="text-xs text-muted-foreground">
				Compact form for card m-lines; verbose form for activity feeds and For You notifications.
			</p>
		</div>
	)
}
