import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import { useCreateTrigger, useTriggers } from '@/hooks/use-triggers'
import type { ProviderEventDefinition, TriggerResponse, WorkspaceWithRole } from '@/lib/api'
type ConditionOperator =
	| 'equals'
	| 'not_equals'
	| 'greater_than'
	| 'less_than'
	| 'before'
	| 'after'
	| 'within_days'
	| 'is_set'
	| 'is_not_set'
	| 'contains'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute, useSearch } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

function TriggersPage() {
	const { workspaceId, workspace } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { create } = useSearch({ from: '/_authed/$workspaceId/settings/triggers/' })
	const [showCreate, setShowCreate] = useState(false)

	useEffect(() => {
		if (create) setShowCreate(true)
	}, [create])

	const agentMap = new Map((actors ?? []).filter((a) => a.type === 'agent').map((a) => [a.id, a]))

	return (
		<div>
			<PageHeader title="Triggers" />

			{showCreate && (
				<div className="mb-6 rounded-lg border border-border bg-card p-4">
					<CreateTriggerForm
						workspaceId={workspaceId}
						workspace={workspace}
						agents={Array.from(agentMap.values())}
						onClose={() => setShowCreate(false)}
					/>
				</div>
			)}

			{isLoading ? (
				<ListSkeleton />
			) : !triggers?.length ? (
				<EmptyState title="No triggers" description="Create a trigger to automate agent actions" />
			) : (
				<div className="space-y-2">
					{triggers.map((trigger) => (
						<TriggerRow
							key={trigger.id}
							trigger={trigger}
							workspaceId={workspaceId}
							agentName={agentMap.get(trigger.targetActorId)?.name ?? 'Unknown'}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function TriggerRow({
	trigger,
	workspaceId,
	agentName,
}: {
	trigger: TriggerResponse
	workspaceId: string
	agentName: string
}) {
	return (
		<Link
			to="/$workspaceId/settings/triggers/$triggerId"
			params={{ workspaceId, triggerId: trigger.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-muted/50 transition-colors"
		>
			<span
				className={`h-3 w-3 rounded-full shrink-0 ${trigger.enabled ? 'bg-success' : 'bg-zinc-600'}`}
			/>
			<div className="flex-1">
				<p className="text-sm font-medium text-foreground">{trigger.name}</p>
				<p className="text-xs text-muted-foreground">
					{trigger.type} → {agentName}
				</p>
			</div>
		</Link>
	)
}

// Internal event definitions (always available)
const INTERNAL_EVENTS: ProviderEventDefinition[] = [
	{ entityType: 'insight', actions: ['created', 'updated', 'status_changed'], label: 'Insight' },
	{ entityType: 'bet', actions: ['created', 'updated', 'status_changed'], label: 'Bet' },
	{ entityType: 'task', actions: ['created', 'updated', 'status_changed'], label: 'Task' },
]

const INTERNAL_ENTITY_TYPES = new Set(['insight', 'bet', 'task'])

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	values?: string[]
}

interface ConditionRow {
	id: string
	field: string
	operator: ConditionOperator
	value: unknown
}

const OPERATORS_BY_TYPE: Record<string, { value: ConditionOperator; label: string }[]> = {
	text: [
		{ value: 'equals', label: 'equals' },
		{ value: 'not_equals', label: 'does not equal' },
		{ value: 'contains', label: 'contains' },
		{ value: 'is_set', label: 'is set' },
		{ value: 'is_not_set', label: 'is not set' },
	],
	number: [
		{ value: 'equals', label: 'equals' },
		{ value: 'not_equals', label: 'does not equal' },
		{ value: 'greater_than', label: 'greater than' },
		{ value: 'less_than', label: 'less than' },
		{ value: 'is_set', label: 'is set' },
		{ value: 'is_not_set', label: 'is not set' },
	],
	date: [
		{ value: 'before', label: 'before' },
		{ value: 'after', label: 'after' },
		{ value: 'within_days', label: 'within days from today' },
		{ value: 'is_set', label: 'is set' },
		{ value: 'is_not_set', label: 'is not set' },
	],
	enum: [
		{ value: 'equals', label: 'equals' },
		{ value: 'not_equals', label: 'does not equal' },
		{ value: 'is_set', label: 'is set' },
		{ value: 'is_not_set', label: 'is not set' },
	],
	boolean: [
		{ value: 'equals', label: 'equals' },
		{ value: 'is_set', label: 'is set' },
		{ value: 'is_not_set', label: 'is not set' },
	],
}

const NO_VALUE_OPERATORS = new Set(['is_set', 'is_not_set'])

function CreateTriggerForm({
	workspaceId,
	workspace,
	agents,
	onClose,
}: {
	workspaceId: string
	workspace: WorkspaceWithRole
	agents: { id: string; name: string }[]
	onClose: () => void
}) {
	const createTrigger = useCreateTrigger(workspaceId)
	const { data: integrations } = useIntegrations(workspaceId)
	const { data: providers } = useProviders()
	const [name, setName] = useState('')
	const [type, setType] = useState<'cron' | 'event' | 'reminder'>('event')
	const [frequency, setFrequency] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily')
	const [minute, setMinute] = useState('0')
	const [hour, setHour] = useState('9')
	const [dayOfWeek, setDayOfWeek] = useState('1')
	const [dayOfMonth, setDayOfMonth] = useState('1')

	const buildCronExpression = useCallback(() => {
		switch (frequency) {
			case 'hourly':
				return `${minute} * * * *`
			case 'daily':
				return `${minute} ${hour} * * *`
			case 'weekly':
				return `${minute} ${hour} * * ${dayOfWeek}`
			case 'monthly':
				return `${minute} ${hour} ${dayOfMonth} * *`
		}
	}, [frequency, minute, hour, dayOfWeek, dayOfMonth])
	const [scheduledDate, setScheduledDate] = useState('')
	const [scheduledTime, setScheduledTime] = useState('09:00')
	const [entityType, setEntityType] = useState('insight')
	const [action, setAction] = useState('created')
	const [prompt, setPrompt] = useState('')
	const [targetActorId, setTargetActorId] = useState(agents[0]?.id ?? '')
	const [fromStatus, setFromStatus] = useState('__any__')
	const [toStatus, setToStatus] = useState('__any__')
	const [conditions, setConditions] = useState<ConditionRow[]>([])

	// Workspace settings
	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined)?.[entityType] ??
		[]
	const statuses = (settings?.statuses as Record<string, string[]> | undefined)?.[entityType] ?? []

	// Build available event definitions from internal + connected integrations
	const connectedProviders = new Set(
		(integrations ?? []).filter((i) => i.status === 'active').map((i) => i.provider),
	)
	const externalEvents =
		(providers ?? []).filter((p) => connectedProviders.has(p.name)).flatMap((p) => p.events) ?? []
	const allEvents = [...INTERNAL_EVENTS, ...externalEvents]

	// Get actions for the currently selected entity type
	const currentEventDef = allEvents.find((e) => e.entityType === entityType)
	const availableActions = currentEventDef?.actions ?? []

	const isInternal = INTERNAL_ENTITY_TYPES.has(entityType)

	const isValid =
		name.trim() && prompt.trim() && targetActorId && (type === 'reminder' ? scheduledDate : true)

	const handleEntityTypeChange = (val: string) => {
		setEntityType(val)
		const def = allEvents.find((e) => e.entityType === val)
		if (def?.actions.length) setAction(def.actions[0])
		setFromStatus('__any__')
		setToStatus('__any__')
		setConditions([])
	}

	const addCondition = () => {
		if (fieldDefs.length === 0) return
		const first = fieldDefs[0]
		const ops = OPERATORS_BY_TYPE[first.type] ?? OPERATORS_BY_TYPE.text
		setConditions([
			...conditions,
			{ id: crypto.randomUUID(), field: first.name, operator: ops[0].value, value: '' },
		])
	}

	const updateCondition = (index: number, updates: Partial<ConditionRow>) => {
		setConditions(conditions.map((c, i) => (i === index ? { ...c, ...updates } : c)))
	}

	const removeCondition = (index: number) => {
		setConditions(conditions.filter((_, i) => i !== index))
	}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!isValid) return

		const validConditions = conditions
			.filter((c) => c.field && c.operator)
			.map((c) =>
				NO_VALUE_OPERATORS.has(c.operator) ? { field: c.field, operator: c.operator } : c,
			)

		const base = {
			name,
			action_prompt: prompt,
			target_actor_id: targetActorId,
		} as const

		const payload =
			type === 'cron'
				? { ...base, type: 'cron' as const, config: { expression: buildCronExpression() } }
				: type === 'reminder'
					? {
							...base,
							type: 'reminder' as const,
							config: {
								scheduled_at: new Date(`${scheduledDate}T${scheduledTime}`).toISOString(),
							},
						}
					: {
							...base,
							type: 'event' as const,
							config: {
								entity_type: entityType,
								action,
								...(fromStatus && fromStatus !== '__any__' && { from_status: fromStatus }),
								...(toStatus && toStatus !== '__any__' && { to_status: toStatus }),
								...(validConditions.length > 0 && { conditions: validConditions }),
							},
						}

		try {
			await createTrigger.mutateAsync(payload)
			onClose()
		} catch {
			// error is accessible via createTrigger.error
		}
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-3">
			{agents.length === 0 && (
				<div className="rounded bg-warning/10 px-3 py-2 text-sm text-warning">
					No agents available. Create an agent first before setting up triggers.
				</div>
			)}
			<Input
				type='text'
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Trigger name"
				autoFocus
			/>
			<div className="flex gap-2">
				{(['event', 'cron', 'reminder'] as const).map((t) => (
					<Button
						key={t}
						type='button'
						variant={type === t ? 'default' : 'secondary'}
						size='sm'
						onClick={() => setType(t)}
					>
						{t}
					</Button>
				))}
			</div>
			{type === 'cron' ? (
				<CronScheduleBuilder
					frequency={frequency}
					minute={minute}
					hour={hour}
					dayOfWeek={dayOfWeek}
					dayOfMonth={dayOfMonth}
					onFrequencyChange={setFrequency}
					onMinuteChange={setMinute}
					onHourChange={setHour}
					onDayOfWeekChange={setDayOfWeek}
					onDayOfMonthChange={setDayOfMonth}
				/>
			) : type === 'reminder' ? (
				<div className="flex gap-2">
					<Input
						type='date'
						value={scheduledDate}
						onChange={(e) => setScheduledDate(e.target.value)}
						className="flex-1"
					/>
					<Input
						type='time'
						value={scheduledTime}
						onChange={(e) => setScheduledTime(e.target.value)}
						className="w-[130px]"
					/>
				</div>
			) : (
				<>
					<div className="flex gap-2">
						<Select value={entityType} onValueChange={handleEntityTypeChange}>
							<SelectTrigger className="flex-1">
								<SelectValue placeholder="Entity type" />
							</SelectTrigger>
							<SelectContent>
								{allEvents.map((e) => (
									<SelectItem key={e.entityType} value={e.entityType}>
										{e.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={action} onValueChange={setAction}>
							<SelectTrigger className="flex-1">
								<SelectValue placeholder="Action" />
							</SelectTrigger>
							<SelectContent>
								{availableActions.map((a) => (
									<SelectItem key={a} value={a}>
										{a}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Status transition selectors for status_changed */}
					{action === 'status_changed' && statuses.length > 0 && (
						<div className="flex gap-2">
							<Select value={fromStatus} onValueChange={setFromStatus}>
								<SelectTrigger className="flex-1">
									<SelectValue placeholder="From status (any)" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__any__">Any status</SelectItem>
									{statuses.map((s) => (
										<SelectItem key={s} value={s}>
											{s}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<span className="flex items-center text-xs text-muted-foreground">→</span>
							<Select value={toStatus} onValueChange={setToStatus}>
								<SelectTrigger className="flex-1">
									<SelectValue placeholder="To status (any)" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__any__">Any status</SelectItem>
									{statuses.map((s) => (
										<SelectItem key={s} value={s}>
											{s}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Metadata conditions */}
					{isInternal && (
						<div className="space-y-2">
							{conditions.map((condition, index) => (
								<ConditionEditor
									key={condition.id}
									condition={condition}
									fieldDefs={fieldDefs}
									onChange={(updates) => updateCondition(index, updates)}
									onRemove={() => removeCondition(index)}
								/>
							))}
							{fieldDefs.length > 0 ? (
								<Button
									type='button'
									variant='ghost'
									size='sm'
									className="text-xs text-muted-foreground"
									onClick={addCondition}
								>
									+ Add condition
								</Button>
							) : conditions.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									No properties defined for {entityType}s. Configure them in{' '}
									<span className="underline">Properties</span> settings to add conditions.
								</p>
							) : null}
						</div>
					)}
				</>
			)}
			<Textarea
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				placeholder="Action prompt for the agent..."
				className="min-h-[60px]"
			/>
			{agents.length > 0 && (
				<Select value={targetActorId} onValueChange={setTargetActorId}>
					<SelectTrigger>
						<SelectValue placeholder="Select agent..." />
					</SelectTrigger>
					<SelectContent>
						{agents.map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{createTrigger.isError && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{createTrigger.error?.message || 'Failed to create trigger'}
				</div>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={!isValid || createTrigger.isPending}>
					Create
				</Button>
			</div>
		</form>
	)
}

function ConditionEditor({
	condition,
	fieldDefs,
	onChange,
	onRemove,
}: {
	condition: ConditionRow
	fieldDefs: FieldDefinition[]
	onChange: (updates: Partial<ConditionRow>) => void
	onRemove: () => void
}) {
	const fieldDef = fieldDefs.find((f) => f.name === condition.field)
	const fieldType = fieldDef?.type ?? 'text'
	const operators = OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE.text
	const needsValue = !NO_VALUE_OPERATORS.has(condition.operator)

	const handleFieldChange = (newField: string) => {
		const def = fieldDefs.find((f) => f.name === newField)
		const newType = def?.type ?? 'text'
		const newOps = OPERATORS_BY_TYPE[newType] ?? OPERATORS_BY_TYPE.text
		onChange({ field: newField, operator: newOps[0].value, value: '' })
	}

	return (
		<div className="flex items-center gap-1.5">
			{/* Field selector */}
			<Select value={condition.field} onValueChange={handleFieldChange}>
				<SelectTrigger className="w-32 h-8 text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{fieldDefs.map((f) => (
						<SelectItem key={f.name} value={f.name}>
							{f.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{/* Operator selector */}
			<Select
				value={condition.operator}
				onValueChange={(op) => onChange({ operator: op as ConditionOperator, value: '' })}
			>
				<SelectTrigger className="w-40 h-8 text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{operators.map((op) => (
						<SelectItem key={op.value} value={op.value}>
							{op.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{/* Value input */}
			{needsValue && (
				<ConditionValueInput
					fieldDef={fieldDef}
					operator={condition.operator}
					value={condition.value}
					onChange={(value) => onChange({ value })}
				/>
			)}

			{/* Remove button */}
			<Button
				type="button"
				variant="ghost"
				size='sm'
				className="h-8 w-8 p-0 text-muted-foreground hover:text-error shrink-0"
				onClick={onRemove}
			>
				<X size={14} />
			</Button>
		</div>
	)
}

function ConditionValueInput({
	fieldDef,
	operator,
	value,
	onChange,
}: {
	fieldDef?: FieldDefinition
	operator: string
	value: unknown
	onChange: (value: unknown) => void
}) {
	const fieldType = fieldDef?.type ?? 'text'

	if (operator === 'within_days') {
		return (
			<Input
				type="number"
				min={1}
				value={String(value ?? '')}
				onChange={(e) => onChange(Number(e.target.value))}
				placeholder="days"
				className="w-20 h-8 text-xs"
			/>
		)
	}

	if (fieldType === 'enum' && fieldDef?.values) {
		return (
			<Select value={String(value ?? '')} onValueChange={onChange}>
				<SelectTrigger className="w-32 h-8 text-xs">
					<SelectValue placeholder="Select..." />
				</SelectTrigger>
				<SelectContent>
					{fieldDef.values.map((v) => (
						<SelectItem key={v} value={v}>
							{v}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		)
	}

	if (fieldType === 'boolean') {
		return (
			<Select value={String(value ?? 'true')} onValueChange={(v) => onChange(v === 'true')}>
				<SelectTrigger className="w-20 h-8 text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="true">Yes</SelectItem>
					<SelectItem value="false">No</SelectItem>
				</SelectContent>
			</Select>
		)
	}

	if (fieldType === 'date') {
		return (
			<Input
				type='date'
				value={String(value ?? '')}
				onChange={(e) => onChange(e.target.value)}
				className="w-36 h-8 text-xs"
			/>
		)
	}

	if (fieldType === 'number') {
		return (
			<Input
				type="number"
				value={String(value ?? '')}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-24 h-8 text-xs"
			/>
		)
	}

	return (
		<Input
			type="text"
			value={String(value ?? '')}
			onChange={(e) => onChange(e.target.value)}
			placeholder="value"
			className="w-32 h-8 text-xs"
		/>
	)
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({
	value: String(i),
	label: i === 0 ? '12:00 AM' : i < 12 ? '${i}:00 AM' : i === 12 ? '12:00 PM' : '${i - 12}:00 PM',
}))

const MINUTES = Array.from({ length: 60 }, (_, i) => ({
	value: String(i),
	label: String(i).padStart(2, '0'),
}))

const DAYS_OF_WEEK = [
	{ value: '1', label: 'Monday' },
	{ value: '2', label: 'Tuesday' },
	{ value: '3', label: 'Wednesday' },
	{ value: '4', label: 'Thursday' },
	{ value: '5', label: 'Friday' },
	{ value: '6', label: 'Saturday' },
	{ value: '0', label: 'Sunday' },
]

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
	value: String(i + 1),
	label: String(i + 1),
}))

function CronScheduleBuilder({
	frequency,
	minute,
	hour,
	dayOfWeek,
	dayOfMonth,
	onFrequencyChange,
	onMinuteChange,
	onHourChange,
	onDayOfWeekChange,
	onDayOfMonthChange,
}: {
	frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
	minute: string
	hour: string
	dayOfWeek: string
	dayOfMonth: string
	onFrequencyChange: (v: 'hourly' | 'daily' | 'weekly' | 'monthly') => void
	onMinuteChange: (v: string) => void
	onHourChange: (v: string) => void
	onDayOfWeekChange: (v: string) => void
	onDayOfMonthChange: (v: string) => void
}) {
	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				{(['hourly', 'daily', 'weekly', 'monthly'] as const).map((f) => (
					<Button
						key={f}
						type='button'
						variant={frequency === f ? 'default' : 'secondary'}
						size='sm'
						onClick={() => onFrequencyChange(f)}
					>
						{f.charAt(0).toUpperCase() + f.slice(1)}
					</Button>
				))}
			</div>

			<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				{frequency === 'monthly' && (
					<>
						<span>on day</span>
						<Select value={dayOfMonth} onValueChange={onDayOfMonthChange}>
							<SelectTrigger className="w-[70px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DAYS_OF_MONTH.map((d) => (
									<SelectItem key={d.value} value={d.value}>
										{d.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				)}

				{frequency === 'weekly' && (
					<>
						<span>on</span>
						<Select value={dayOfWeek} onValueChange={onDayOfWeekChange}>
							<SelectTrigger className="w-[130px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DAYS_OF_WEEK.map((d) => (
									<SelectItem key={d.value} value={d.value}>
										{d.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				)}

				{frequency !== 'hourly' && (
					<>
						<span>at</span>
						<Select value={hour} onValueChange={onHourChange}>
							<SelectTrigger className="w-[120px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{HOURS.map((h) => (
									<SelectItem key={h.value} value={h.value}>
										{h.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				)}

				{frequency === 'hourly' && (
					<>
						<span>at minute</span>
						<Select value={minute} onValueChange={onMinuteChange}>
							<SelectTrigger className="w-[70px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{MINUTES.map((m) => (
									<SelectItem key={m.value} value={m.value}>
										{m.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				)}
			</div>
		</div>
	)
}
