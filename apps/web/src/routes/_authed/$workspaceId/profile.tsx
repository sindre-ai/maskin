import { AvatarRow } from '@/components/profile/avatar-row'
import { DeleteAccountDialog } from '@/components/profile/delete-account-dialog'
import { EmailRow } from '@/components/profile/email-row'
import { PasswordRow } from '@/components/profile/password-row'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useActor } from '@/hooks/use-actors'
import { useAutoSave } from '@/hooks/use-auto-save'
import { trackEvent } from '@/lib/analytics'
import { type ActorResponse, type NotificationPrefs, type UpdateActorInput, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { ACTOR_BIO_MAX_LENGTH } from '@maskin/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/profile')({
	component: ProfilePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// Defaults mirror notificationPrefsSchema in packages/shared. An actor row with
// notification_prefs=null (pre-T2 backfill) is treated as if every key were at
// its schema default.
const NOTIFICATION_DEFAULTS: NotificationPrefs = {
	mentions: true,
	subscribed: true,
	betStatusChanges: true,
	weeklyDigest: false,
}

const NOTIFICATION_ROWS: ReadonlyArray<{
	key: keyof NotificationPrefs
	label: string
	hint: string
}> = [
	{
		key: 'mentions',
		label: 'Mentions and replies',
		hint: 'Notify me when someone @mentions me or replies to my comment.',
	},
	{
		key: 'subscribed',
		label: 'Subscribed objects',
		hint: 'Notify me about activity on objects I follow.',
	},
	{
		key: 'betStatusChanges',
		label: 'Bet status changes',
		hint: 'Notify me when a bet I own moves between proposed, active, paused, or completed.',
	},
	{
		key: 'weeklyDigest',
		label: 'Weekly digest',
		hint: 'Send me a weekly email rollup of workspace activity.',
	},
]

function ProfilePage() {
	const stored = getStoredActor()
	const actorId = stored?.id ?? ''
	const { data: actor } = useActor(actorId)

	useEffect(() => {
		trackEvent('profile.viewed')
	}, [])

	return (
		<div className="mx-auto w-full max-w-2xl">
			<header className="mb-6">
				<h1 className="text-lg font-semibold text-foreground">Profile</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Your identity in Maskin. Visible to others in workspaces you've joined.
				</p>
			</header>

			<Section label="Identity">
				{actor ? <AvatarRow actor={actor} /> : <SkeletonRow label="Avatar" />}
				{actor ? <DisplayNameRow actor={actor} /> : <SkeletonRow label="Display name" />}
				{actor ? <BioRow actor={actor} /> : <SkeletonRow label="Bio" />}
			</Section>

			<Section label="Account">
				{actor ? <EmailRow actor={actor} /> : <SkeletonRow label="Email" />}
				<PasswordRow />
			</Section>

			<Section label="Notifications">
				{actor ? (
					<NotificationPrefsRows actor={actor} />
				) : (
					NOTIFICATION_ROWS.map((row) => <SkeletonRow key={row.key} label={row.label} />)
				)}
			</Section>

			{actor ? <DangerZone actor={actor} /> : null}
		</div>
	)
}

function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section className="mt-7 first:mt-0">
			<h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</h2>
			<div className="divide-y divide-border border-t border-border">{children}</div>
		</section>
	)
}

function Row({
	label,
	children,
	hint,
}: {
	label: string
	children: ReactNode
	hint?: ReactNode
}) {
	const rowKey = label.toLowerCase().replace(/\s+/g, '-')
	return (
		<div
			data-row={rowKey}
			className="grid grid-cols-1 gap-1 py-3.5 md:grid-cols-[160px_1fr] md:items-start md:gap-4"
		>
			<div className="pt-1 text-sm font-medium text-muted-foreground">{label}</div>
			<div className="flex flex-col gap-1">
				{children}
				{hint ? <div className="text-xs text-muted-foreground/80">{hint}</div> : null}
			</div>
		</div>
	)
}

function PlaceholderRow({ label }: { label: string }) {
	return (
		<Row label={label}>
			<div className="pt-1 text-sm italic text-muted-foreground/70">Coming soon</div>
		</Row>
	)
}

function SkeletonRow({ label }: { label: string }) {
	return (
		<Row label={label}>
			<div className="h-9 w-full max-w-xs animate-pulse rounded-md bg-muted/60" />
		</Row>
	)
}

function DisplayNameRow({ actor }: { actor: ActorResponse }) {
	const [value, setValue] = useState(actor.name)
	const { save, isError } = useProfileFieldSave(actor.id)
	const trimmed = value.trim()
	const tooLong = value.length > 80
	const isValid = trimmed.length > 0 && !tooLong

	const buildPayload = useCallback((): UpdateActorInput | null => {
		if (!isValid || trimmed === actor.name) return null
		return { name: trimmed }
	}, [isValid, trimmed, actor.name])

	const { showSaved } = useAutoSave({
		isActive: true,
		isValid,
		buildPayload,
		onSave: save,
	})

	return (
		<Row
			label="Display name"
			hint={<SaveHint isValid={isValid} showSaved={showSaved} isError={isError} />}
		>
			<Input
				aria-label="Display name"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="Your name"
				className={cn('max-w-sm', !isValid && 'border-destructive')}
				maxLength={120}
			/>
			{trimmed.length === 0 ? (
				<span className="text-xs text-destructive">Display name can't be empty.</span>
			) : tooLong ? (
				<span className="text-xs text-destructive">Display name is too long.</span>
			) : null}
		</Row>
	)
}

function BioRow({ actor }: { actor: ActorResponse }) {
	const initial = actor.bio ?? ''
	const [value, setValue] = useState(initial)
	const { save, isError } = useProfileFieldSave(actor.id)
	const tooLong = value.length > ACTOR_BIO_MAX_LENGTH
	const isValid = !tooLong

	const buildPayload = useCallback((): UpdateActorInput | null => {
		const next = value.length === 0 ? null : value
		if (!isValid || next === (actor.bio ?? null)) return null
		return { bio: next }
	}, [isValid, value, actor.bio])

	const { showSaved } = useAutoSave({
		isActive: true,
		isValid,
		buildPayload,
		onSave: save,
	})

	return (
		<Row
			label="Bio"
			hint={
				<div className="flex items-center justify-between gap-2">
					<SaveHint isValid={isValid} showSaved={showSaved} isError={isError} />
					<span
						className={cn(
							'text-xs tabular-nums text-muted-foreground/80',
							tooLong && 'text-destructive',
						)}
					>
						{value.length}/{ACTOR_BIO_MAX_LENGTH}
					</span>
				</div>
			}
		>
			<Textarea
				aria-label="Bio"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="A short bio."
				className={cn('min-h-[88px] max-w-xl', !isValid && 'border-destructive')}
				autoResize
			/>
			{tooLong ? (
				<span className="text-xs text-destructive">
					Bio is over the {ACTOR_BIO_MAX_LENGTH}-character limit.
				</span>
			) : null}
		</Row>
	)
}

function SaveHint({
	isValid,
	showSaved,
	isError,
}: {
	isValid: boolean
	showSaved: boolean
	isError: boolean
}) {
	if (!isValid) return null
	if (isError) return <span className="text-xs text-destructive">Save failed — try again.</span>
	if (showSaved) return <span className="text-xs text-muted-foreground">Saved</span>
	return null
}

function useProfileFieldSave(actorId: string) {
	const queryClient = useQueryClient()
	const mutation = useMutation({
		mutationFn: (input: UpdateActorInput) => api.actors.update(actorId, input),
		onMutate: async (input) => {
			const key = queryKeys.actors.detail(actorId)
			await queryClient.cancelQueries({ queryKey: key })
			const previous = queryClient.getQueryData<ActorResponse>(key)
			if (previous) {
				queryClient.setQueryData<ActorResponse>(key, { ...previous, ...input })
			}
			return { previous }
		},
		onError: (_err, _input, ctx) => {
			if (ctx?.previous) {
				queryClient.setQueryData(queryKeys.actors.detail(actorId), ctx.previous)
			}
			toast.error('Could not save profile change')
		},
		onSuccess: (_result, input) => {
			for (const field of Object.keys(input)) {
				trackEvent('profile.field_changed', { field })
			}
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(actorId) })
		},
	})

	const save = useCallback(
		(payload: UpdateActorInput) => {
			mutation.mutate(payload)
		},
		[mutation],
	)

	return { save, isError: mutation.isError }
}

function NotificationPrefsRows({ actor }: { actor: ActorResponse }) {
	// Send the fully merged object on each toggle: the backend partial-merges
	// either way, but the React Query cache update in useProfileFieldSave is a
	// shallow `{ ...prev, ...input }` — passing a partial would optimistically
	// drop the other three keys until the network response lands.
	const prefs = { ...NOTIFICATION_DEFAULTS, ...(actor.notification_prefs ?? {}) }
	const { save, isError } = useProfileFieldSave(actor.id)

	return (
		<>
			{NOTIFICATION_ROWS.map((row) => (
				<NotificationPrefRow
					key={row.key}
					prefKey={row.key}
					label={row.label}
					hint={row.hint}
					checked={prefs[row.key]}
					onChange={(next) => save({ notification_prefs: { ...prefs, [row.key]: next } })}
					isError={isError}
				/>
			))}
		</>
	)
}

function NotificationPrefRow({
	prefKey,
	label,
	hint,
	checked,
	onChange,
	isError,
}: {
	prefKey: keyof NotificationPrefs
	label: string
	hint: string
	checked: boolean
	onChange: (next: boolean) => void
	isError: boolean
}) {
	const hintId = `notification-pref-${prefKey}-hint`
	const errorId = `notification-pref-${prefKey}-error`
	return (
		<Row
			label={label}
			hint={
				isError ? (
					<span id={errorId} className="text-xs text-destructive">
						Save failed — try again.
					</span>
				) : (
					<span id={hintId}>{hint}</span>
				)
			}
		>
			<Switch
				aria-label={label}
				aria-describedby={isError ? errorId : hintId}
				data-pref-key={prefKey}
				checked={checked}
				onCheckedChange={onChange}
			/>
		</Row>
	)
}

function DangerZone({ actor }: { actor: ActorResponse }) {
	const [open, setOpen] = useState(false)
	const [dialogOpen, setDialogOpen] = useState(false)
	const { workspaceId } = useWorkspace()
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="mt-12">
			<div className="overflow-hidden rounded-lg border border-border">
				<CollapsibleTrigger
					className={cn(
						'flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-destructive',
						'transition-colors hover:bg-muted/40',
					)}
				>
					<span>Delete account</span>
					<ChevronRight
						className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent
					data-row="delete-account"
					className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<p className="text-sm text-muted-foreground">
						Permanently delete your account, profile, API keys, and any workspaces you solely own.
					</p>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						onClick={() => setDialogOpen(true)}
						aria-label="Delete account…"
					>
						Delete account…
					</Button>
				</CollapsibleContent>
			</div>
			<DeleteAccountDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				actorId={actor.id}
				workspaceId={workspaceId}
			/>
		</Collapsible>
	)
}
