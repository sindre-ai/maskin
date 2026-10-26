import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useDailyBudget, useSetDailyBudget } from '@/hooks/use-billing'
import { cn } from '@/lib/cn'
import {
	DAILY_BUDGET_STOP_SHARES,
	DAILY_BUDGET_UNITS,
	DEFAULT_DAILY_BUDGET_STOP_SHARE,
	type DailyBudget,
	dailyBudgetSchema,
} from '@maskin/shared'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

type Unit = (typeof DAILY_BUDGET_UNITS)[number]
type StopShare = (typeof DAILY_BUDGET_STOP_SHARES)[number]

interface Draft {
	enabled: boolean
	unit: Unit
	amount: string
	stopShare: StopShare
}

const UNIT_LABEL: Record<Unit, string> = { tokens: 'Tokens', dollars: 'Dollars' }

const UNIT_HELP: Record<Unit, string> = {
	tokens: 'Tokens match how your Claude plan counts, so this is the safer choice.',
	dollars: 'Dollars follow what each model costs. Subscription plans may not report a cost.',
}

function draftFrom(saved: DailyBudget | null): Draft {
	return {
		enabled: saved !== null,
		unit: saved?.unit ?? 'tokens',
		amount: saved ? String(saved.amount) : '',
		stopShare: saved?.stop_share ?? DEFAULT_DAILY_BUDGET_STOP_SHARE,
	}
}

function sameDraft(a: Draft, b: Draft): boolean {
	return (
		a.enabled === b.enabled &&
		(!a.enabled ||
			(a.unit === b.unit && a.amount.trim() === b.amount.trim() && a.stopShare === b.stopShare))
	)
}

function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
	} catch {
		return 'UTC'
	}
}

/** Returns the message to show under the amount field, or null when the draft is valid. */
export function amountError(unit: Unit, amount: string): string | null {
	const n = Number(amount.trim())
	if (amount.trim() === '' || !Number.isFinite(n) || n <= 0) return 'Enter a number above 0.'
	if (unit === 'tokens' && !Number.isInteger(n)) return 'Enter a whole number of tokens.'
	if (unit === 'dollars' && Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
		return 'Dollars can have at most two decimals.'
	}
	return null
}

function formatAmount(unit: Unit, amount: string): string {
	const n = Number(amount)
	if (unit === 'dollars') return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
	return `${n.toLocaleString('en-US')} tokens`
}

function PillGroup<T extends string | number>({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string
	value: T
	options: { value: T; label: string; disabled?: boolean }[]
	onChange: (value: T) => void
	disabled?: boolean
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="flex w-full gap-1 rounded-xl border border-border bg-background p-1 sm:inline-flex sm:w-auto"
		>
			{options.map((option) => {
				const active = value === option.value
				return (
					<button
						key={option.value}
						type="button"
						// biome-ignore lint/a11y/useSemanticElements: custom pill styling; ARIA radio semantics preserved
						role="radio"
						aria-checked={active}
						disabled={disabled || option.disabled}
						onClick={() => onChange(option.value)}
						className={cn(
							'flex flex-1 items-center justify-center rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none',
							active
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{option.label}
					</button>
				)
			})}
		</div>
	)
}

/**
 * Settings, Billing: the one daily target for the workspace (slice 1a of the
 * daily token budget bet). It only reports for now: the stop-at share is stored
 * and nothing is held or stopped. Mounted by the Billing route behind the
 * daily-budget flag.
 */
export function DailyBudgetSection({
	workspaceId,
	canEdit,
}: {
	workspaceId: string
	canEdit: boolean
}) {
	const query = useDailyBudget(workspaceId)
	const save = useSetDailyBudget(workspaceId)
	// null = follow the saved value; set once the owner touches a field.
	const [edited, setEdited] = useState<Draft | null>(null)
	const [justSaved, setJustSaved] = useState(false)
	// The amount error waits until the owner has typed or left the field.
	const [amountTouched, setAmountTouched] = useState(false)

	if (query.isLoading) {
		return (
			<div data-testid="daily-budget-loading" aria-busy="true" className="space-y-2">
				<Label className="text-bold">Daily budget</Label>
				<Skeleton className="h-16 w-full rounded-xl" />
			</div>
		)
	}

	if (query.isError || !query.data) {
		return (
			<div>
				<Label className="mb-1 text-bold">Daily budget</Label>
				<p className="text-xs text-error">
					{query.error?.message ?? 'Could not load the daily budget.'}
				</p>
			</div>
		)
	}

	const { daily_budget: saved, dollar_unit: dollarUnit } = query.data
	const savedDraft = draftFrom(saved)
	const draft = edited ?? savedDraft
	const dirty = !sameDraft(draft, savedDraft)
	const error = draft.enabled ? amountError(draft.unit, draft.amount) : null
	const showError = error !== null && amountTouched
	const timezone = saved?.timezone ?? browserTimezone()
	const disabled = !canEdit || save.isPending

	const update = (patch: Partial<Draft>) => {
		setJustSaved(false)
		setEdited({ ...draft, ...patch })
	}

	const handleSave = () => {
		if (draft.enabled && error) return
		let next: DailyBudget | null = null
		if (draft.enabled) {
			const parsed = dailyBudgetSchema.safeParse({
				unit: draft.unit,
				amount: Number(draft.amount.trim()),
				stop_share: draft.stopShare,
				timezone,
			})
			if (!parsed.success) return
			next = parsed.data
		}
		save.mutate(next, {
			onSuccess: () => {
				setEdited(null)
				setJustSaved(true)
				toast.success('Daily budget saved')
			},
		})
	}

	return (
		<div data-testid="daily-budget">
			<Label className="mb-1 text-bold">Daily budget</Label>
			<p className="mb-3 text-xs text-muted-foreground">
				The plan above is your limit for the period. This is a target for each day, so you can see
				whether you spend evenly.
			</p>

			<div className="space-y-4 rounded-xl border border-border bg-card p-3">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<span className="block text-[12.5px] font-semibold">Set a daily target</span>
						<span className="text-xs text-muted-foreground">
							For now the target only reports. Nothing is held or stopped yet, and work keeps
							running as before.
						</span>
					</div>
					<Switch
						checked={draft.enabled}
						disabled={disabled}
						onCheckedChange={(enabled) => update({ enabled })}
						aria-label="Set a daily target"
					/>
				</div>

				{draft.enabled && (
					<>
						<div className="space-y-1.5">
							<Label>Count the target in</Label>
							<PillGroup
								label="Count the target in"
								value={draft.unit}
								disabled={disabled}
								options={DAILY_BUDGET_UNITS.map((unit) => ({
									value: unit,
									label: UNIT_LABEL[unit],
									disabled: unit === 'dollars' && !dollarUnit.available,
								}))}
								onChange={(unit) => update({ unit })}
							/>
							<p className="text-xs text-muted-foreground">
								{!dollarUnit.available && dollarUnit.reason
									? dollarUnit.reason
									: UNIT_HELP[draft.unit]}
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="daily-budget-amount">Target per day</Label>
							<div className="flex items-center gap-2">
								{draft.unit === 'dollars' && (
									<span className="text-sm text-muted-foreground">$</span>
								)}
								<Input
									id="daily-budget-amount"
									inputMode="decimal"
									autoComplete="off"
									className={cn('sm:max-w-[200px]', showError && 'border-error')}
									value={draft.amount}
									disabled={disabled}
									aria-invalid={showError}
									aria-describedby={showError ? 'daily-budget-amount-error' : undefined}
									onBlur={() => setAmountTouched(true)}
									onChange={(e) => {
										setAmountTouched(true)
										update({ amount: e.target.value })
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' && dirty && !error) handleSave()
									}}
								/>
								{draft.unit === 'tokens' && (
									<span className="text-sm text-muted-foreground">tokens</span>
								)}
							</div>
							{showError && (
								<p id="daily-budget-amount-error" className="text-xs text-error">
									{error}
								</p>
							)}
						</div>

						<div className="space-y-1.5">
							<Label>Stop starting new work at</Label>
							<PillGroup
								label="Stop starting new work at"
								value={draft.stopShare}
								disabled={disabled}
								options={DAILY_BUDGET_STOP_SHARES.map((share) => ({
									value: share,
									label: `${share}%`,
								}))}
								onChange={(stopShare) => update({ stopShare })}
							/>
							<p className="text-xs text-muted-foreground">
								Leaves room for work already running. A run that has started is never stopped.
							</p>
						</div>

						<p className="text-xs text-muted-foreground">
							{error === null &&
								`Target ${formatAmount(draft.unit, draft.amount)} a day, stopping new work at ${draft.stopShare}%. `}
							A day runs 00:00 to 24:00 in {timezone}.
						</p>
					</>
				)}

				{!canEdit && (
					<p className="text-xs text-muted-foreground">
						Only workspace owners and admins can change the daily budget.
					</p>
				)}

				{save.isError && (
					<p role="alert" className="text-xs text-error">
						Could not save. Your target is unchanged. Try again.
					</p>
				)}

				{canEdit && (dirty || justSaved) && (
					<div className="flex items-center gap-2">
						{dirty ? (
							<>
								<Button
									size="sm"
									onClick={handleSave}
									disabled={save.isPending || (draft.enabled && error !== null)}
								>
									{save.isPending ? 'Saving…' : 'Save'}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={save.isPending}
									onClick={() => {
										setEdited(null)
										setAmountTouched(false)
										save.reset()
									}}
								>
									Cancel
								</Button>
							</>
						) : (
							// biome-ignore lint/a11y/useSemanticElements: inline span keeps the layout; role=status carries the live-region semantics
							<span className="inline-flex items-center gap-1 text-xs text-success" role="status">
								<Check size={14} /> Saved
							</span>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
