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
import { useAutoSave } from '@/hooks/use-auto-save'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import type { ProviderEventDefinition, TriggerResponse, WorkspaceWithRole } from '@/lib/api'
import { getAllWebModules } from '@ai-native/module-sdk'
import type { SafeJsonValue } from '@ai-native/shared'
import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

// --- Types ---

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

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	values?: string[]
}

interface ConditionRow {
	id: string
	field: string
	operator: ConditionOperator
	value: SafeJsonValue
}

export interface TriggerFormPayload {
	name: string
	type: 'cron' | 'event' | 'reminder'
	action_prompt: string
	target_actor_id: string
	config: Record<string, unknown>
	enabled?: boolean
}

// --- Constants ---

const INTERNAL_EVENTS: ProviderEventDefinition[] = getAllWebModules().flatMap((mod) =>
	mod.objectTypeTabs.map((t) => ({
		entityType: t.value,
		actions: ['created', 'updated', 'status_changed'],
		label: t.label,
	})),
)

const INTERNAL_ENTITY_TYPES = new Set(
	getAllWebModules().flatMap((mod) => mod.objectTypeTabs.map((t) => t.value)),
)

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

const HOURS = Array.from({ length: 24 }, (_, i) => ({
	value: String(i),
	label: i === 0 ? '12:00 AM' : i < 12 ? `${i}:00 AM` : i === 12 ? '12:00 PM' : `${i - 12}:00 PM`,
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

// --- Cron parser ---

function parseCronExpression(expr: string): {
	frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
	minute: string
	hour: string
	dayOfWeek: string
	dayOfMonth: string
} {
	const parts = expr.split(' ')
	const [minute = '0', hour = '9', dayOfMonth = '1', , dayOfWeek = '1'] = parts

	if (dayOfWeek !== '*') return { frequency: 'weekly', minute, hour, dayOfWeek, dayOfMonth: '1' }
	if (dayOfMonth !== '*') return { frequency: 'monthly', minute, hour, dayOfWeek: '1', dayOfMonth }
	if (hour !== '*') return { frequency: 'daily', minute, hour, dayOfWeek: '1', dayOfMonth: '1' }
	return { frequency: 'hourly', minute, hour: '9', dayOfWeek: '1', dayOfMonth: '1' }
}

// --- Main form ---

export function TriggerForm({
	workspaceId,
	workspace,
	agents,
	initialValues,
	onAutoCreate,
	onSave,
	onToggleEnabled,
	isPending = false,
	error,
	isCreated = false,
}: {
	workspaceId: string
	workspace: WorkspaceWithRole
	agents: { id: string; name: string }[]
	initialValues?: TriggerResponse
	onAutoCreate?: (payload: TriggerFormPayload) => void
	onSave?: (payload: TriggerFormPayload) => void
	onToggleEnabled?: () => void
	isPending?: boolean
	error?: Error | null
	isCreated?: boolean
}) {
	const { data: integrations } = useIntegrations(workspaceId)
	const { data: providers } = useProviders()

	// Parse initial config
	const initConfig = (initialValues?.config as Record<string, unknown>) ?? {}
	const initCron =
		initialValues?.type === 'cron' && initConfig.expression
			? parseCronExpression(String(initConfig.expression))
			: null

	const [name, setName] = useState(initialValues?.name ?? '')
	const [type, setType] = useState<'cron' | 'event' | 'reminder'>(
		(initialValues?.type as 'cron' | 'event' | 'reminder') ?? 'event',
	)
	const [frequency, setFrequency] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>(
		initCron?.frequency ?? 'daily',
	)
	const [minute, setMinute] = useState(initCron?.minute ?? '0')
	const [hour, setHour] = useState(initCron?.hour ?? '9')
	const [dayOfWeek, setDayOfWeek] = useState(initCron?.dayOfWeek ?? '1')
	const [dayOfMonth, setDayOfMonth] = useState(initCron?.dayOfMonth ?? '1')

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

	const initScheduledAt =
		initialValues?.type === 'reminder' && initConfig.scheduled_at
			? new Date(String(initConfig.scheduled_at))
			: null
	const [scheduledDate, setScheduledDate] = useState(
		initScheduledAt ? initScheduledAt.toISOString().slice(0, 10) : '',
	)
	const [scheduledTime, setScheduledTime] = useState(
		initScheduledAt
			? `${String(initScheduledAt.getHours()).padStart(2, '0')}:${String(initScheduledAt.getMinutes()).padStart(2, '0')}`
			: '09:00',
	)

	const [entityType, setEntityType] = useState(
		initialValues?.type === 'event' && initConfig.entity_type
			? String(initConfig.entity_type)
			: 'insight',
	)
	const [action, setAction] = useState(
		initialValues?.type === 'event' && initConfig.action ? String(initConfig.action) : 'created',
	)
	const [prompt, setPrompt] = useState(initialValues?.actionPrompt ?? '')
	const [targetActorId, setTargetActorId] = useState(
		initialValues?.targetActorId ?? agents[0]?.id ?? '',
	)
	const [enabled, setEnabled] = useState(initialValues?.enabled ?? true)
	const [fromStatus, setFromStatus] = useState(
		initialValues?.type === 'event' && initConfig.from_status
			? String(initConfig.from_status)
			: '__any__',
	)
	const [toStatus, setToStatus] = useState(
		initialValues?.type === 'event' && initConfig.to_status
			? String(initConfig.to_status)
			: '__any__',
	)
	const [conditions, setConditions] = useState<ConditionRow[]>(() => {
		if (initialValues?.type === 'event' && Array.isArray(initConfig.conditions)) {
			return (
				initConfig.conditions as { field: string; operator: string; value?: SafeJsonValue }[]
			).map((c) => ({
				id: crypto.randomUUID(),
				field: c.field,
				operator: c.operator as ConditionOperator,
				value: (c.value ?? '') as SafeJsonValue,
			}))
		}
		return []
	})

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

	const currentEventDef = allEvents.find((e) => e.entityType === entityType)
	const availableActions = currentEventDef?.actions ?? []
	const isInternal = INTERNAL_ENTITY_TYPES.has(entityType)

	const isValid =
		name.trim() && prompt.trim() && targetActorId && (type === 'reminder' ? scheduledDate : true)

	// --- Build payload from current form state ---
	const hasAutoCreatedRef = useRef(false)

	const buildPayload = useCallback((): TriggerFormPayload | null => {
		if (!name.trim() || !prompt.trim() || !targetActorId) return null
		if (type === 'reminder' && !scheduledDate) return null

		const validConditions = conditions
			.filter((c) => c.field && c.operator)
			.map((c) =>
				NO_VALUE_OPERATORS.has(c.operator) ? { field: c.field, operator: c.operator } : c,
			)

		const config =
			type === 'cron'
				? { expression: buildCronExpression() }
				: type === 'reminder'
					? { scheduled_at: new Date(`${scheduledDate}T${scheduledTime}`).toISOString() }
					: {
							entity_type: entityType,
							action,
							...(fromStatus && fromStatus !== '__any__' && { from_status: fromStatus }),
							...(toStatus && toStatus !== '__any__' && { to_status: toStatus }),
							...(validConditions.length > 0 && { conditions: validConditions }),
						}

		return {
			name: name.trim(),
			type,
			action_prompt: prompt.trim(),
			target_actor_id: targetActorId,
			config,
			enabled,
		}
	}, [
		name,
		prompt,
		targetActorId,
		enabled,
		type,
		scheduledDate,
		scheduledTime,
		conditions,
		buildCronExpression,
		entityType,
		action,
		fromStatus,
		toStatus,
	])

	// --- Auto-create: fire once when form first becomes valid ---
	useEffect(() => {
		if (!onAutoCreate || hasAutoCreatedRef.current || !isValid) return
		const payload = buildPayload()
		if (!payload) return
		hasAutoCreatedRef.current = true
		onAutoCreate(payload)
	}, [isValid, onAutoCreate, buildPayload])

	// --- Debounced auto-save for edits ---
	const { showSaved: showSaving } = useAutoSave({
		isActive: isCreated,
		isValid: !!isValid,
		buildPayload,
		onSave,
	})

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

	return (
		<div className="space-y-3">
			{agents.length === 0 && (
				<div className="rounded bg-warning/10 px-3 py-2 text-sm text-warning">
					No agents available. Create an agent first before setting up triggers.
				</div>
			)}

			<Input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Trigger name"
				autoFocus={!initialValues}
			/>

			<div className="flex gap-2">
				{(['event', 'cron', 'reminder'] as const).map((t) => (
					<Button
						key={t}
						type="button"
						variant={type === t ? 'default' : 'secondary'}
						size="sm"
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
						type="date"
						value={scheduledDate}
						onChange={(e) => setScheduledDate(e.target.value)}
						className="flex-1"
					/>
					<Input
						type="time"
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
									type="button"
									variant="ghost"
									size="sm"
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

			{/* Enabled toggle */}
			<div className="flex items-center gap-3">
				<span
					className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
						enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
					}`}
				>
					<span className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-success' : 'bg-zinc-600'}`} />
					{enabled ? 'Enabled' : 'Disabled'}
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setEnabled(!enabled)
						if (isCreated && onToggleEnabled) onToggleEnabled()
					}}
				>
					{enabled ? 'Disable' : 'Enable'}
				</Button>
			</div>

			{error && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error.message || 'Something went wrong'}
				</div>
			)}

			{showSaving && (
				<p className="flex items-center gap-1 text-xs text-muted-foreground">
					<Check size={14} />
					Saved
				</p>
			)}
		</div>
	)
}

// --- Sub-components ---

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
			<Select value={condition.field} onValueChange={handleFieldChange}>
				<SelectTrigger>
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

			<Select
				value={condition.operator}
				onValueChange={(op) => onChange({ operator: op as ConditionOperator, value: '' })}
			>
				<SelectTrigger>
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

			{needsValue && (
				<ConditionValueInput
					fieldDef={fieldDef}
					operator={condition.operator}
					value={condition.value}
					onChange={(value) => onChange({ value })}
				/>
			)}

			<Button
				type="button"
				variant="ghost"
				size="sm"
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
	value: SafeJsonValue
	onChange: (value: SafeJsonValue) => void
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
				<SelectTrigger>
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
				<SelectTrigger>
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
				type="date"
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
						type="button"
						variant={frequency === f ? 'default' : 'secondary'}
						size="sm"
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
							<SelectTrigger>
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
							<SelectTrigger>
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
							<SelectTrigger>
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
							<SelectTrigger>
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
