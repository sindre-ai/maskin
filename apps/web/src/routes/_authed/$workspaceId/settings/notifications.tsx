import { BrowserNotificationsToggle } from '@/components/profile/browser-notifications-row'
import { SettingsPageTitle } from '@/components/settings/settings-page-title'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useDocumentTitle } from '@/hooks/use-document-title'
import {
	useNotificationPreferences,
	useUpdateNotificationPreferences,
} from '@/hooks/use-notification-preferences'
import { useWebPush } from '@/hooks/use-web-push'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { sortBy } from '@/lib/sort'
import type { PushCategory, UpdateNotificationPreferencesInput } from '@maskin/shared'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/settings/notifications')({
	component: NotificationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/** 510 -> "08:30". Minutes from local midnight, as the API stores them. */
function formatMinuteOfDay(minutes: number) {
	const h = String(Math.floor(minutes / 60)).padStart(2, '0')
	const m = String(minutes % 60).padStart(2, '0')
	return `${h}:${m}`
}

function parseTimeInput(value: string): number | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value)
	return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

const DEFAULT_QUIET_START = 22 * 60
const DEFAULT_QUIET_END = 7 * 60

const SECTION_LABEL = 'px-2 pt-8 pb-1.5 text-[13px] font-semibold text-muted-foreground'
// Cobalt when on (mockup), the locked state greyed rather than dimmed.
const SWITCH_CLASS =
	'shrink-0 data-[state=checked]:bg-brand data-[state=checked]:disabled:bg-muted-foreground/50'

type SaveFn = (data: UpdateNotificationPreferencesInput) => void

interface ChannelSwitch {
	checked: boolean
	onChange: (next: boolean) => void
	/** The person was never asked about this channel; the switch shows what they get by default. */
	notAsked?: boolean
	/** Shown but not changeable here, like Needs you while on. */
	locked?: boolean
}

/** One labelled switch in a fixed-width column. The label shows wherever there is no header above the columns. */
function SwitchCell({
	label,
	ariaLabel,
	channel,
	labelClass,
}: {
	label: string
	ariaLabel: string
	channel: ChannelSwitch
	labelClass: string
}) {
	return (
		<div className="flex w-16 flex-col items-center gap-1">
			<span className={`text-[11px] text-muted-foreground ${labelClass}`}>{label}</span>
			<Switch
				checked={channel.checked}
				onCheckedChange={(next) => channel.onChange(!!next)}
				aria-label={ariaLabel}
				disabled={channel.locked}
				className={SWITCH_CLASS}
			/>
			{channel.notAsked && <span className="text-[11px] text-muted-foreground">Not asked</span>}
		</div>
	)
}

function PreferenceRow({
	title,
	description,
	checked,
	onChange,
	locked = false,
	email,
	browser,
	columns = false,
}: {
	title: string
	description: string
	checked: boolean
	onChange: (next: boolean) => void
	/** Push is shown but not changeable here, e.g. "Needs you", which ignores quiet hours. */
	locked?: boolean
	/** A switch for the same row, sent by email instead of push. */
	email?: ChannelSwitch
	/** A switch for the same row, shown in this browser. */
	browser?: ChannelSwitch
	/** Part of the Email, Push, Browser table: keeps the switches in line when a row has fewer. */
	columns?: boolean
}) {
	// Three fixed-width columns leave the text too little room at tablet width, so the table
	// layout starts at lg. A row without columns has one switch and can go side by side sooner.
	const labelClass = columns ? 'lg:hidden' : 'sm:hidden'
	const empty = <div className="hidden w-16 lg:block" />
	return (
		<div
			className={`flex flex-col gap-3 px-2 py-3.5 ${
				columns
					? 'lg:flex-row lg:items-center lg:justify-between lg:gap-4'
					: 'sm:flex-row sm:items-center sm:justify-between sm:gap-4'
			}`}
		>
			<div className="min-w-0">
				<span className="block text-[15px] font-medium leading-tight">{title}</span>
				<span className="block text-[13px] text-muted-foreground">{description}</span>
			</div>
			<div
				className={`flex shrink-0 items-start gap-1 ${columns ? 'lg:items-center' : 'sm:items-center'}`}
			>
				{email ? (
					<SwitchCell
						label="Email"
						ariaLabel={`${title} by email`}
						channel={email}
						labelClass={labelClass}
					/>
				) : (
					columns && empty
				)}
				<SwitchCell
					label="Push"
					ariaLabel={title}
					channel={{ checked, onChange, locked }}
					labelClass={labelClass}
				/>
				{browser ? (
					<SwitchCell
						label="Browser"
						ariaLabel={`${title} in the browser`}
						channel={browser}
						labelClass={labelClass}
					/>
				) : (
					columns && empty
				)}
			</div>
		</div>
	)
}

/**
 * Settings → Notifications. The API stores a Push and a Browser switch per category, one Push
 * switch for the daily briefing, and one email switch, which sits on the Digests row. A Browser
 * switch the person never touched shows "Not asked" and follows that category's Push switch.
 */
function NotificationsPage() {
	useDocumentTitle('Notifications')
	const { data: prefs, isLoading, isError, error, refetch } = useNotificationPreferences()
	const update = useUpdateNotificationPreferences()
	const save: SaveFn = (data) =>
		update.mutate(data, {
			onError: () => toast.error('Failed to save your notification settings'),
		})

	if (isLoading) return <ListSkeleton />
	if (isError || !prefs) {
		return (
			<QueryStateError
				title="Couldn't load your notification settings"
				error={error}
				onRetry={() => refetch()}
			/>
		)
	}

	const browserSwitch = (kind: PushCategory): ChannelSwitch => ({
		checked: prefs.browser_categories[kind],
		onChange: (next) => save({ browser_categories: { [kind]: next } }),
		notAsked: prefs.browser_not_asked.includes(kind),
		// Same rule as Push: Needs you stays on once on, and can always be turned on.
		locked: kind === 'needs_you' && prefs.browser_categories[kind],
	})

	return (
		<div className="max-w-[760px]">
			<SettingsPageTitle title="Notifications" subtitle="Choose what reaches you, and where." />
			<div className="flex items-center justify-between px-2 pb-1.5 text-[15px] font-semibold text-foreground">
				<span>Notify me about</span>
				<div className="hidden items-center gap-1 lg:flex">
					<span className="w-16 text-center">Email</span>
					<span className="w-16 text-center">Push</span>
					<span className="w-16 text-center">Browser</span>
				</div>
			</div>
			<div className="divide-y divide-border-subtle border-y border-border-subtle">
				<PreferenceRow
					title="Needs you"
					description="Decisions and questions. Ignores quiet hours."
					// Greyed while on; a saved-off value stays editable so it can never get stuck off.
					locked={prefs.categories.needs_you}
					checked={prefs.categories.needs_you}
					onChange={(next) => save({ categories: { needs_you: next } })}
					email={{
						checked: prefs.email_categories.needs_you,
						onChange: (next) => save({ email_categories: { needs_you: next } }),
					}}
					browser={browserSwitch('needs_you')}
					columns
				/>
				<PreferenceRow
					title="Chat replies"
					description="When someone answers you in a chat."
					checked={prefs.categories.conversation}
					onChange={(next) => save({ categories: { conversation: next } })}
					email={{
						checked: prefs.email_categories.conversation,
						onChange: (next) => save({ email_categories: { conversation: next } }),
					}}
					browser={browserSwitch('conversation')}
					columns
				/>
				<PreferenceRow
					title={`Daily briefing at ${formatMinuteOfDay(prefs.briefing_time)}`}
					description="One message each morning, separate from Digests."
					checked={prefs.briefing_enabled}
					onChange={(next) => save({ briefing_enabled: next })}
					columns
				/>
				<PreferenceRow
					title="Digests"
					description="Summaries of what your agents got done."
					checked={prefs.categories.digest}
					onChange={(next) => save({ categories: { digest: next } })}
					email={{
						checked: prefs.email_digest_enabled,
						onChange: (next) => save({ email_digest_enabled: next }),
					}}
					browser={browserSwitch('digest')}
					columns
				/>
				<PreferenceRow
					title="Flow activity"
					description="When one of your flows finishes a run. Off until you switch it on."
					checked={prefs.categories.flow_activity}
					onChange={(next) => save({ categories: { flow_activity: next } })}
					email={{
						checked: prefs.email_categories.flow_activity,
						onChange: (next) => save({ email_categories: { flow_activity: next } }),
					}}
					browser={browserSwitch('flow_activity')}
					columns
				/>
				<PreferenceRow
					title="Tips and updates"
					description="What is new in Maskin."
					checked={prefs.categories.tips}
					onChange={(next) => save({ categories: { tips: next } })}
					email={{
						checked: prefs.email_categories.tips,
						onChange: (next) => save({ email_categories: { tips: next } }),
					}}
					browser={browserSwitch('tips')}
					columns
				/>
				<QuietHoursRow
					start={prefs.quiet_hours_start}
					end={prefs.quiet_hours_end}
					timezone={prefs.timezone}
					onSave={save}
				/>
			</div>
			<BrowserSection />
			<WorkspaceMutes muted={prefs.muted_workspace_ids} onSave={save} />
			<p className="px-2 pt-4.5 text-[13px] leading-normal text-muted-foreground">
				Needs you ignores quiet hours. Muting a workspace never mutes its decisions.
			</p>
		</div>
	)
}

function QuietHoursRow({
	start,
	end,
	timezone,
	onSave,
}: {
	start: number | null
	end: number | null
	timezone: string | null
	onSave: SaveFn
}) {
	const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
	const change = (which: 'start' | 'end', value: string) => {
		const minutes = parseTimeInput(value)
		if (minutes === null) return
		onSave({
			timezone: zone,
			quiet_hours_start: which === 'start' ? minutes : (start ?? DEFAULT_QUIET_START),
			quiet_hours_end: which === 'end' ? minutes : (end ?? DEFAULT_QUIET_END),
		})
	}
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 px-2 py-3.5">
			<div className="min-w-0">
				<span className="block text-[15px] font-medium leading-tight">Quiet hours</span>
				<span className="block text-[13px] text-muted-foreground">
					Holds everything except Needs you.
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{start !== null && end !== null && (
					<>
						<Input
							type="time"
							value={formatMinuteOfDay(start)}
							onChange={(e) => change('start', e.target.value)}
							aria-label="Quiet hours start"
							className="w-28 rounded-full border-0 bg-secondary"
						/>
						<span className="text-[13px] text-muted-foreground">to</span>
						<Input
							type="time"
							value={formatMinuteOfDay(end)}
							onChange={(e) => change('end', e.target.value)}
							aria-label="Quiet hours end"
							className="w-28 rounded-full border-0 bg-secondary"
						/>
					</>
				)}
				<Switch
					checked={start !== null && end !== null}
					onCheckedChange={(next) =>
						onSave(
							next
								? {
										timezone: zone,
										quiet_hours_start: DEFAULT_QUIET_START,
										quiet_hours_end: DEFAULT_QUIET_END,
									}
								: { quiet_hours_start: null, quiet_hours_end: null },
						)
					}
					aria-label="Quiet hours"
					className={SWITCH_CLASS}
				/>
			</div>
		</div>
	)
}

/** Per browser, not per account — hidden where this browser cannot do web push at all. */
function BrowserSection() {
	const { state } = useWebPush()
	if (state === 'unavailable') return null
	return (
		<>
			<h2 className={SECTION_LABEL}>This browser</h2>
			<div className="flex items-center justify-between gap-4 border-y border-border-subtle px-2 py-3.5">
				<div className="min-w-0">
					<span className="block text-[15px] font-medium leading-tight">Browser notifications</span>
					<span className="block text-[13px] text-muted-foreground">
						So decisions reach you when they matter
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<BrowserNotificationsToggle />
				</div>
			</div>
		</>
	)
}

function WorkspaceMutes({ muted, onSave }: { muted: string[]; onSave: SaveFn }) {
	const { data: workspaces } = useWorkspaces()
	const rows = sortBy(
		workspaces ?? [],
		(w) => w.name,
		(w) => w.id,
	)
	if (rows.length === 0) return null
	return (
		<>
			<h2 className={SECTION_LABEL}>Workspaces</h2>
			<div className="divide-y divide-border-subtle border-y border-border-subtle">
				{rows.map((w) => (
					<PreferenceRow
						key={w.id}
						title={`Mute chat replies, digests and tips in ${w.name}`}
						description="Decisions that need you still arrive."
						checked={muted.includes(w.id)}
						onChange={(next) =>
							onSave({
								muted_workspace_ids: next ? [...muted, w.id] : muted.filter((id) => id !== w.id),
							})
						}
					/>
				))}
			</div>
		</>
	)
}
