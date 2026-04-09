import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export const Route = createFileRoute('/_authed/$workspaceId/settings/objects/')({
	component: ObjectsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ObjectsPage() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)

	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}

	const enabledModules = useEnabledModules()
	const objectTypes = getEnabledObjectTypeTabs(enabledModules).map((t) => t.value)
	const [activeType, setActiveType] = useState(objectTypes[0])

	useEffect(() => {
		if (objectTypes.length > 0 && !objectTypes.includes(activeType)) {
			setActiveType(objectTypes[0])
		}
	}, [objectTypes, activeType])

	const [showAdd, setShowAdd] = useState(false)
	const [newName, setNewName] = useState('')
	const [newType, setNewType] = useState<FieldDefinition['type']>('text')
	const [newEnumValues, setNewEnumValues] = useState('')

	const currentFields = fieldDefs[activeType] ?? []

	const handleAdd = () => {
		const trimmed = newName.trim()
		if (!trimmed || currentFields.some((f) => f.name === trimmed)) return

		const newField: FieldDefinition = {
			name: trimmed,
			type: newType,
			...(newType === 'enum' && newEnumValues.trim()
				? {
						values: newEnumValues
							.split(',')
							.map((v) => v.trim())
							.filter(Boolean),
					}
				: {}),
		}

		const updatedDefs = {
			...fieldDefs,
			[activeType]: [...currentFields, newField],
		}

		updateWorkspace.mutate({
			settings: { ...settings, field_definitions: updatedDefs },
		})
		setNewName('')
		setNewType('text')
		setNewEnumValues('')
		setShowAdd(false)
	}

	return (
		<div>
			{/* Properties section */}
			<h2 className="text-sm font-medium text-foreground mb-4">Properties</h2>

			<div className="flex items-center justify-between mb-4">
				<div className="inline-flex rounded-md border border-border">
					{objectTypes.map((type) => (
						<button
							key={type}
							type="button"
							className={cn(
								'px-3 py-1.5 text-sm capitalize transition-colors first:rounded-l-md last:rounded-r-md',
								activeType === type
									? 'bg-primary text-primary-foreground'
									: 'bg-background text-muted-foreground hover:bg-muted',
							)}
							onClick={() => setActiveType(type)}
						>
							{type}
						</button>
					))}
				</div>
				{!showAdd && (
					<Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
						<Plus size={14} className="mr-1" />
						Add property
					</Button>
				)}
			</div>

			{showAdd && (
				<div className="mb-4 rounded-lg border border-border bg-card p-4 space-y-3">
					<Input
						type="text"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						placeholder="Property name (e.g. Due Date)"
						autoFocus
					/>
					<div className="flex gap-1 flex-wrap">
						{(['text', 'number', 'date', 'boolean', 'enum'] as const).map((t) => (
							<Button
								key={t}
								type="button"
								variant={newType === t ? 'default' : 'secondary'}
								size="sm"
								onClick={() => setNewType(t)}
							>
								{t}
							</Button>
						))}
					</div>
					{newType === 'enum' && (
						<Input
							type="text"
							value={newEnumValues}
							onChange={(e) => setNewEnumValues(e.target.value)}
							placeholder="Options (comma-separated, e.g. low, medium, high)"
						/>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>
							Cancel
						</Button>
						<Button onClick={handleAdd} disabled={!newName.trim() || updateWorkspace.isPending}>
							Create
						</Button>
					</div>
				</div>
			)}

			{currentFields.length === 0 ? (
				<EmptyState
					title={`No properties for ${activeType}s`}
					description="Create a property to add structured data to your objects"
				/>
			) : (
				<div className="space-y-2">
					{currentFields.map((field) => (
						<Link
							key={field.name}
							to="/$workspaceId/settings/objects/$propertyName"
							params={{ workspaceId, propertyName: field.name }}
							search={{ type: activeType }}
							className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
						>
							<div className="flex-1">
								<p className="text-sm font-medium text-foreground">{field.name}</p>
								<p className="text-xs text-muted-foreground">
									{field.type}
									{field.values ? ` · ${field.values.join(', ')}` : ''}
								</p>
							</div>
						</Link>
					))}
				</div>
			)}

			{/* Relationship types section */}
			<div className="border-t border-border pt-6 mt-6">
				<RelationshipTypesEditor workspace={workspace} workspaceId={workspaceId} />
			</div>
		</div>
	)
}

function RelationshipTypesEditor({
	workspace,
	workspaceId,
}: {
	workspace: import('@/lib/api').WorkspaceWithRole
	workspaceId: string
}) {
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [newType, setNewType] = useState('')

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes = (settings?.relationship_types as string[] | undefined) ?? [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
	]

	const handleAdd = () => {
		const trimmed = newType.trim().toLowerCase().replace(/\s+/g, '_')
		if (!trimmed || relationshipTypes.includes(trimmed)) return
		const updated = [...relationshipTypes, trimmed]
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
		setNewType('')
	}

	const handleRemove = (type: string) => {
		const updated = relationshipTypes.filter((t) => t !== type)
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
	}

	return (
		<div>
			<Label className="mb-2 text-muted-foreground">Relationship types</Label>
			<div className="flex flex-wrap gap-1.5 mb-2">
				{relationshipTypes.map((type) => (
					<span
						key={type}
						className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
					>
						{type.replace(/_/g, ' ')}
						<button
							type="button"
							className="text-muted-foreground hover:text-error ml-0.5"
							onClick={() => handleRemove(type)}
							title={`Remove ${type}`}
						>
							×
						</button>
					</span>
				))}
			</div>
			<div className="flex gap-2">
				<Input
					type="text"
					value={newType}
					onChange={(e) => setNewType(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
					placeholder="New relationship type"
					className="flex-1"
				/>
				<Button
					variant="secondary"
					onClick={handleAdd}
					disabled={!newType.trim() || updateWorkspace.isPending}
				>
					Add
				</Button>
			</div>
		</div>
	)
}
