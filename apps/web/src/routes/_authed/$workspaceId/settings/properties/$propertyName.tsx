import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export const Route = createFileRoute('/_authed/$workspaceId/settings/properties/$propertyName')({
	component: PropertyDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		type: (search.type as string) || 'insight',
	}),
})

function PropertyDetailPage() {
	const { propertyName } = Route.useParams()
	const { type: objectType } = Route.useSearch()
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const navigate = useNavigate()

	const decodedName = decodeURIComponent(propertyName)
	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}
	const typeFields = fieldDefs[objectType] ?? []
	const field = typeFields.find((f) => f.name === decodedName)

	const [name, setName] = useState(field?.name ?? '')
	const [type, setType] = useState<FieldDefinition['type']>(field?.type ?? 'text')
	const [enumValues, setEnumValues] = useState(field?.values?.join(', ') ?? '')
	const [required, setRequired] = useState(field?.required ?? false)

	if (!field) {
		return (
			<div className="flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">Property not found</p>
			</div>
		)
	}

	const hasChanges =
		name !== field.name ||
		type !== field.type ||
		required !== (field.required ?? false) ||
		(type === 'enum' ? enumValues !== (field.values?.join(', ') ?? '') : false)

	const handleSave = () => {
		const trimmedName = name.trim()
		if (!trimmedName) return

		// Check for duplicate name (if renamed)
		if (trimmedName !== field.name && typeFields.some((f) => f.name === trimmedName)) return

		const updatedField: FieldDefinition = {
			name: trimmedName,
			type,
			...(required ? { required: true } : {}),
			...(type === 'enum' && enumValues.trim()
				? {
						values: enumValues
							.split(',')
							.map((v) => v.trim())
							.filter(Boolean),
					}
				: {}),
		}

		const updatedTypeFields = typeFields.map((f) => (f.name === field.name ? updatedField : f))
		const updatedDefs = { ...fieldDefs, [objectType]: updatedTypeFields }

		updateWorkspace.mutate(
			{ settings: { ...settings, field_definitions: updatedDefs } },
			{
				onSuccess: () => {
					// If name changed, navigate to new URL
					if (trimmedName !== field.name) {
						navigate({
							to: '/$workspaceId/settings/properties/$propertyName',
							params: { workspaceId, propertyName: trimmedName },
							search: { type: objectType },
							replace: true,
						})
					}
				},
			},
		)
	}

	const handleDelete = () => {
		const updatedTypeFields = typeFields.filter((f) => f.name !== field.name)
		const updatedDefs = { ...fieldDefs, [objectType]: updatedTypeFields }

		updateWorkspace.mutate(
			{ settings: { ...settings, field_definitions: updatedDefs } },
			{
				onSuccess: () => {
					navigate({
						to: '/$workspaceId/settings/properties',
						params: { workspaceId },
						search: { create: false },
					})
				},
			},
		)
	}

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<h1 className="text-2xl font-semibold tracking-tight text-foreground mb-2">{field.name}</h1>
				<p className="text-xs text-muted-foreground mb-6">
					Applies to <span className="capitalize">{objectType}s</span>
				</p>

				{/* Name */}
				<Section title="Name">
					<Input type="text" value={name} onChange={(e) => setName(e.target.value)} />
				</Section>

				{/* Type */}
				<Section title="Type">
					<div className="flex gap-1 flex-wrap">
						{(['text', 'number', 'date', 'boolean', 'enum'] as const).map((t) => (
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
				</Section>

				{/* Enum values */}
				{type === 'enum' && (
					<Section title="Options">
						<Input
							type="text"
							value={enumValues}
							onChange={(e) => setEnumValues(e.target.value)}
							placeholder="Options (comma-separated, e.g. low, medium, high)"
						/>
					</Section>
				)}

				{/* Required */}
				<Section title="Required">
					<Button
						type="button"
						variant={required ? 'default' : 'secondary'}
						size="sm"
						onClick={() => setRequired(!required)}
					>
						{required ? 'Required' : 'Optional'}
					</Button>
				</Section>

				{/* Save */}
				{hasChanges && (
					<div className="flex justify-end mb-6">
						<Button onClick={handleSave} disabled={!name.trim() || updateWorkspace.isPending}>
							{updateWorkspace.isPending ? 'Saving...' : 'Save changes'}
						</Button>
					</div>
				)}

				{/* Delete */}
				<div className="border-t border-border pt-6">
					<Button
						variant="ghost"
						size="sm"
						className="text-error hover:text-error"
						onClick={handleDelete}
						disabled={updateWorkspace.isPending}
					>
						Delete property
					</Button>
				</div>
			</div>
		</>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				{title}
			</h3>
			{children}
		</div>
	)
}
