import { PropertyTypeGrid, propertyTypeLabel } from '@/components/objects/property-type-grid'
import { SettingsLinkRow } from '@/components/settings/settings-link-row'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useCanWrite } from '@/hooks/use-can-write'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
import { createFileRoute } from '@tanstack/react-router'
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
	const canWrite = useCanWrite()
	const updateWorkspace = useUpdateWorkspace(workspaceId)

	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}

	// A to Z by the label people see, not by registration order.
	const objectTypes = useAvailableObjectTypes()
		.map((t) => ({ value: t.value, label: t.label }))
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
	const typeValues = objectTypes.map((t) => t.value)
	const [activeType, setActiveType] = useState(typeValues[0])

	useEffect(() => {
		if (typeValues.length > 0 && !typeValues.includes(activeType)) {
			setActiveType(typeValues[0])
		}
	}, [typeValues, activeType])

	const [showAdd, setShowAdd] = useState(false)
	const [newName, setNewName] = useState('')
	const [newType, setNewType] = useState<FieldDefinition['type']>('text')
	const [newEnumValues, setNewEnumValues] = useState('')

	const currentFields = fieldDefs[activeType] ?? []
	const activeLabel = objectTypes.find((t) => t.value === activeType)?.label ?? activeType
	const trimmedName = newName.trim()
	const isDuplicate = currentFields.some((f) => f.name === trimmedName)

	const resetForm = () => {
		setNewName('')
		setNewType('text')
		setNewEnumValues('')
	}

	const handleAdd = () => {
		if (!canWrite || !trimmedName || isDuplicate) return

		const newField: FieldDefinition = {
			name: trimmedName,
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
		resetForm()
		setShowAdd(false)
	}

	return (
		<div className="max-w-[760px]">
			<p className="mb-4 px-2 text-[13px] text-muted-foreground">
				What your agents can create and track.
			</p>

			<h2 className="px-2 pb-2 text-xs font-semibold text-foreground">Types</h2>
			<div className="-mx-1 mb-6 overflow-x-auto px-1">
				<div className="inline-flex gap-1 rounded-full bg-secondary p-1">
					{objectTypes.map((type) => (
						<button
							key={type.value}
							type="button"
							aria-pressed={activeType === type.value}
							className={cn(
								'min-h-11 whitespace-nowrap rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition-colors md:min-h-0',
								activeType === type.value
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
							onClick={() => setActiveType(type.value)}
						>
							{type.label}
						</button>
					))}
				</div>
			</div>

			<div className="flex items-center justify-between gap-3 px-2 pb-1.5">
				<h2 className="text-xs font-semibold text-foreground">Properties</h2>
				<ViewerTooltip className="inline-flex shrink-0">
					<Button
						size="sm"
						disabled={!canWrite}
						onClick={() => setShowAdd(true)}
						className="max-md:h-11"
					>
						<Plus size={14} aria-hidden />
						Add property
					</Button>
				</ViewerTooltip>
			</div>

			{currentFields.length === 0 ? (
				<div className="border-y border-border-subtle">
					<EmptyState
						title={`No properties for ${activeLabel.toLowerCase()} items`}
						description="Create a property to add structured data to your items"
					/>
				</div>
			) : (
				<ul className="divide-y divide-border-subtle border-y border-border-subtle">
					{currentFields.map((field) => (
						<li key={field.name}>
							<SettingsLinkRow
								title={field.name}
								description={`${propertyTypeLabel(field.type)}${field.values ? ` · ${field.values.join(', ')}` : ''}`}
								to="/$workspaceId/settings/objects/$propertyName"
								params={{ workspaceId, propertyName: field.name }}
								search={{ type: activeType }}
							/>
						</li>
					))}
				</ul>
			)}

			<h2 className="px-2 pt-8 pb-1.5 text-xs font-semibold text-foreground">Extensions</h2>
			<div className="border-y border-border-subtle">
				<SettingsLinkRow
					title="Extensions"
					description="Calendar, webhooks, CRM and MCP add types and fields."
					to="/$workspaceId/settings/extensions"
					params={{ workspaceId }}
				/>
			</div>

			<ResponsiveDialog
				open={showAdd}
				onOpenChange={(open) => {
					setShowAdd(open)
					if (!open) resetForm()
				}}
			>
				<ResponsiveDialogContent>
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>Add property</ResponsiveDialogTitle>
						<ResponsiveDialogDescription className="sr-only">
							Name the property and pick what kind of value it holds.
						</ResponsiveDialogDescription>
					</ResponsiveDialogHeader>
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault()
							handleAdd()
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor="property-name">Name</Label>
							<Input
								id="property-name"
								type="text"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="e.g. Budget"
								autoFocus
							/>
							{isDuplicate && (
								<p className="text-xs text-error">
									{activeLabel} already has a property called {trimmedName}.
								</p>
							)}
						</div>
						<div className="space-y-1.5">
							<span className="settings-label block">Type</span>
							<PropertyTypeGrid value={newType} onChange={setNewType} />
						</div>
						{newType === 'enum' && (
							<div className="space-y-1.5">
								<Label htmlFor="property-options">Options</Label>
								<Input
									id="property-options"
									type="text"
									value={newEnumValues}
									onChange={(e) => setNewEnumValues(e.target.value)}
									placeholder="Comma-separated, e.g. low, medium, high"
								/>
							</div>
						)}
						<ResponsiveDialogFooter>
							<Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={!trimmedName || isDuplicate || updateWorkspace.isPending || !canWrite}
							>
								Add property
							</Button>
						</ResponsiveDialogFooter>
					</form>
				</ResponsiveDialogContent>
			</ResponsiveDialog>

			{/* Relationship types section */}
			<div className="mt-8 border-t border-border pt-6">
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
	const canWrite = useCanWrite()
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
		if (!canWrite || !trimmed || relationshipTypes.includes(trimmed)) return
		const updated = [...relationshipTypes, trimmed]
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
		setNewType('')
	}

	const handleRemove = (type: string) => {
		if (!canWrite) return
		const updated = relationshipTypes.filter((t) => t !== type)
		updateWorkspace.mutate({
			settings: { ...settings, relationship_types: updated },
		})
	}

	return (
		<div>
			<h2 className="eyebrow mb-3">Relationship types</h2>
			<div className="flex flex-wrap gap-1.5 mb-2">
				{relationshipTypes.map((type) => (
					<span
						key={type}
						className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-secondary px-3 text-xs text-foreground"
					>
						{type.replace(/_/g, ' ')}
						<button
							type="button"
							className="text-muted-foreground hover:text-error ml-0.5 disabled:pointer-events-none disabled:opacity-50"
							onClick={() => handleRemove(type)}
							disabled={!canWrite}
							title={canWrite ? `Remove ${type}` : VIEWER_READ_ONLY_MESSAGE}
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
					placeholder={canWrite ? 'New relationship type' : VIEWER_READ_ONLY_MESSAGE}
					disabled={!canWrite}
					className="flex-1"
				/>
				<ViewerTooltip>
					<Button
						variant="secondary"
						onClick={handleAdd}
						disabled={!newType.trim() || updateWorkspace.isPending || !canWrite}
					>
						Add
					</Button>
				</ViewerTooltip>
			</div>
		</div>
	)
}
