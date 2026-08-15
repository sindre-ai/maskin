import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isObject, safeParseJson } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'

type FieldType = 'text' | 'number' | 'date' | 'enum' | 'boolean'

interface FieldDef {
	name: string
	type: FieldType
	required?: boolean
	values?: string[]
}

interface TypeSchema {
	display_name: string
	statuses: string[]
	fields: FieldDef[]
}

interface WorkspaceSchema {
	workspace_id: string
	workspace_name: string
	relationship_types: string[]
	types: Record<string, TypeSchema>
}

const FIELD_TYPES: FieldType[] = ['text', 'number', 'date', 'enum', 'boolean']

function SchemaApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	switch (toolResult.toolName) {
		case 'get_workspace_schema':
			return isObject<WorkspaceSchema>(data, 'workspace_id', 'types') ? (
				<SchemaEditor schema={data} />
			) : (
				<MessageView message={text} />
			)
		case 'create_workspace_field':
		case 'update_workspace_field':
			return <FieldChangedView toolName={toolResult.toolName} payload={data} />
		case 'delete_workspace_field':
			return <FieldDeletedView payload={data} />
		default:
			return <MessageView message={text} />
	}
}

function MessageView({ message }: { message: string }) {
	return (
		<div className="p-4 max-w-2xl">
			<pre className="text-xs whitespace-pre-wrap break-words text-foreground">{message}</pre>
		</div>
	)
}

function SchemaEditor({ schema }: { schema: WorkspaceSchema }) {
	const callTool = useCallTool()
	const [types, setTypes] = useState<Record<string, TypeSchema>>(schema.types)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setTypes(schema.types)
	}, [schema.types])

	const typeNames = useMemo(() => Object.keys(types).sort(), [types])

	const refresh = useCallback(async () => {
		const result = await callTool('get_workspace_schema', { workspace_id: schema.workspace_id })
		const next = result.content?.find((c) => c.type === 'text')?.text
		if (!next) return
		const parsed = safeParseJson(next)
		if (isObject<WorkspaceSchema>(parsed, 'workspace_id', 'types')) {
			setTypes(parsed.types)
		}
	}, [callTool, schema.workspace_id])

	const runTool = useCallback(
		async (key: string, name: string, args: Record<string, unknown>) => {
			setBusy(key)
			setError(null)
			try {
				await callTool(name, { workspace_id: schema.workspace_id, ...args })
				await refresh()
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				setBusy(null)
			}
		},
		[callTool, refresh, schema.workspace_id],
	)

	if (typeNames.length === 0) {
		return (
			<EmptyState
				title="No object types"
				description="This workspace has no extensions or types yet"
			/>
		)
	}

	return (
		<div className="p-4 max-w-3xl space-y-6">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-lg font-semibold text-foreground">{schema.workspace_name}</h1>
					<p className="text-xs text-muted-foreground">
						Workspace schema — {typeNames.length} type{typeNames.length === 1 ? '' : 's'}
					</p>
				</div>
				<WebAppLink target={{ kind: 'settings', section: 'objects' }} label="Open in Maskin" />
			</div>

			{error && (
				<div className="text-xs text-destructive border border-destructive/40 rounded-md p-2">
					{error}
				</div>
			)}

			<div className="space-y-6">
				{typeNames.map((typeName) => (
					<TypeSection
						key={typeName}
						typeName={typeName}
						typeSchema={types[typeName] as TypeSchema}
						busy={busy}
						runTool={runTool}
					/>
				))}
			</div>
		</div>
	)
}

function TypeSection({
	typeName,
	typeSchema,
	busy,
	runTool,
}: {
	typeName: string
	typeSchema: TypeSchema
	busy: string | null
	runTool: (key: string, name: string, args: Record<string, unknown>) => Promise<void>
}) {
	const [adding, setAdding] = useState(false)

	return (
		<div className="border border-border rounded-lg overflow-hidden">
			<div className="flex items-center justify-between px-4 py-2 bg-muted/40">
				<div>
					<h2 className="text-sm font-semibold text-foreground capitalize">
						{typeSchema.display_name}
					</h2>
					<p className="text-xs text-muted-foreground">
						{typeSchema.fields.length} field{typeSchema.fields.length === 1 ? '' : 's'}
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)} disabled={!!busy}>
					<Plus className="size-3.5 mr-1" />
					Add field
				</Button>
			</div>

			{adding && (
				<div className="border-t border-border px-4 py-3 bg-bg-surface">
					<NewFieldForm
						typeName={typeName}
						existingNames={typeSchema.fields.map((f) => f.name)}
						busy={busy === `new-${typeName}`}
						onCancel={() => setAdding(false)}
						onSubmit={async (field) => {
							await runTool(`new-${typeName}`, 'create_workspace_field', {
								type: typeName,
								name: field.name,
								field_type: field.type,
								required: field.required,
								values: field.values,
							})
							setAdding(false)
						}}
					/>
				</div>
			)}

			{typeSchema.fields.length === 0 ? (
				<div className="px-4 py-6 text-center text-xs text-muted-foreground">No fields yet</div>
			) : (
				<ul className="divide-y divide-border">
					{typeSchema.fields.map((field) => (
						<li key={field.name}>
							<FieldRow typeName={typeName} field={field} busy={busy} runTool={runTool} />
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

function FieldRow({
	typeName,
	field,
	busy,
	runTool,
}: {
	typeName: string
	field: FieldDef
	busy: string | null
	runTool: (key: string, name: string, args: Record<string, unknown>) => Promise<void>
}) {
	const rowKey = `${typeName}:${field.name}`
	const isBusy = busy === rowKey
	const [newValue, setNewValue] = useState('')

	return (
		<div className="px-4 py-3 space-y-2">
			<div className="flex items-center gap-3">
				<span className="text-sm text-foreground flex-1 font-medium">{field.name}</span>
				<span className="text-xs text-muted-foreground capitalize">{field.type}</span>
				<div className="flex items-center gap-1">
					<Switch
						checked={field.required ?? false}
						onCheckedChange={(checked) =>
							runTool(rowKey, 'update_workspace_field', {
								type: typeName,
								name: field.name,
								required: checked,
							})
						}
						disabled={isBusy}
						aria-label={`Required for ${field.name}`}
					/>
					<span className="text-xs text-muted-foreground">Required</span>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() =>
						runTool(rowKey, 'delete_workspace_field', { type: typeName, name: field.name })
					}
					disabled={isBusy}
					aria-label={`Delete ${field.name}`}
					className="text-muted-foreground hover:text-destructive"
				>
					<Trash2 className="size-3.5" />
				</Button>
			</div>
			{field.type === 'enum' && (
				<div className="flex flex-wrap items-center gap-1 pl-1">
					{(field.values ?? []).map((value) => (
						<span
							key={value}
							className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-surface px-2 py-0.5 text-xs text-foreground"
						>
							{value}
							<button
								type="button"
								disabled={isBusy}
								onClick={() =>
									runTool(rowKey, 'update_workspace_field', {
										type: typeName,
										name: field.name,
										remove_values: [value],
									})
								}
								aria-label={`Remove ${value}`}
								className="text-muted-foreground hover:text-destructive"
							>
								<X className="size-3" />
							</button>
						</span>
					))}
					<form
						className="inline-flex items-center gap-1"
						onSubmit={async (e) => {
							e.preventDefault()
							const trimmed = newValue.trim()
							if (!trimmed) return
							await runTool(rowKey, 'update_workspace_field', {
								type: typeName,
								name: field.name,
								add_values: [trimmed],
							})
							setNewValue('')
						}}
					>
						<Input
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
							placeholder="Add value"
							className="h-7 text-xs w-32"
							disabled={isBusy}
						/>
						<Button type="submit" size="sm" variant="outline" disabled={isBusy || !newValue.trim()}>
							Add
						</Button>
					</form>
				</div>
			)}
		</div>
	)
}

function NewFieldForm({
	typeName,
	existingNames,
	busy,
	onCancel,
	onSubmit,
}: {
	typeName: string
	existingNames: string[]
	busy: boolean
	onCancel: () => void
	onSubmit: (field: {
		name: string
		type: FieldType
		required: boolean
		values?: string[]
	}) => Promise<void>
}) {
	const [name, setName] = useState('')
	const [type, setType] = useState<FieldType>('text')
	const [required, setRequired] = useState(false)
	const [valuesText, setValuesText] = useState('')
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		const trimmedName = name.trim()
		if (!trimmedName) {
			setError('Name is required')
			return
		}
		if (existingNames.includes(trimmedName)) {
			setError(`Field "${trimmedName}" already exists on ${typeName}`)
			return
		}
		const values =
			type === 'enum'
				? valuesText
						.split(',')
						.map((v) => v.trim())
						.filter(Boolean)
				: undefined
		if (type === 'enum' && (!values || values.length === 0)) {
			setError('Enum fields require at least one value')
			return
		}
		setError(null)
		await onSubmit({ name: trimmedName, type, required, values })
	}

	return (
		<form onSubmit={submit} className="space-y-2">
			<div className="grid grid-cols-2 gap-2">
				<div>
					<label
						htmlFor={`new-field-name-${typeName}`}
						className="text-xs text-muted-foreground block mb-1"
					>
						Name
					</label>
					<Input
						id={`new-field-name-${typeName}`}
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={busy}
						placeholder="priority"
					/>
				</div>
				<div>
					<label
						htmlFor={`new-field-type-${typeName}`}
						className="text-xs text-muted-foreground block mb-1"
					>
						Type
					</label>
					<Select value={type} onValueChange={(v) => setType(v as FieldType)} disabled={busy}>
						<SelectTrigger id={`new-field-type-${typeName}`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FIELD_TYPES.map((t) => (
								<SelectItem key={t} value={t}>
									{t}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			{type === 'enum' && (
				<div>
					<label
						htmlFor={`new-field-values-${typeName}`}
						className="text-xs text-muted-foreground block mb-1"
					>
						Values (comma-separated)
					</label>
					<Input
						id={`new-field-values-${typeName}`}
						value={valuesText}
						onChange={(e) => setValuesText(e.target.value)}
						disabled={busy}
						placeholder="low, medium, high"
					/>
				</div>
			)}
			<div className="flex items-center gap-2">
				<Switch
					checked={required}
					onCheckedChange={setRequired}
					disabled={busy}
					aria-label="Required"
				/>
				<span className="text-xs text-muted-foreground">Required</span>
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex justify-end gap-2 pt-1">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={busy || !name.trim()}>
					{busy ? 'Adding...' : 'Add field'}
				</Button>
			</div>
		</form>
	)
}

function FieldChangedView({
	toolName,
	payload,
}: {
	toolName: string
	payload: unknown
}) {
	const verb = toolName === 'create_workspace_field' ? 'created' : 'updated'
	const summary = isObject<{ workspace_id: string; type: string; field?: FieldDef }>(
		payload,
		'workspace_id',
		'type',
	)
		? payload
		: null
	return (
		<div className="p-4 max-w-2xl space-y-2">
			<p className="text-sm text-foreground">
				Field {verb}
				{summary?.field?.name ? ` — ${summary.field.name}` : ''}.
			</p>
			{summary && (
				<pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
					{JSON.stringify(summary, null, 2)}
				</pre>
			)}
		</div>
	)
}

function FieldDeletedView({ payload }: { payload: unknown }) {
	const summary = isObject<{ workspace_id: string; type: string; deleted: string }>(
		payload,
		'workspace_id',
		'type',
		'deleted',
	)
		? payload
		: null
	return (
		<div className="p-4 max-w-2xl">
			<p className="text-sm text-foreground">
				Field {summary?.deleted ? `"${summary.deleted}" ` : ''}deleted.
			</p>
		</div>
	)
}

renderMcpApp('Schema', <SchemaApp />)
