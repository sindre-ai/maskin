import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import { Link, createFileRoute, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export const Route = createFileRoute('/_authed/$workspaceId/settings/properties/')({
	component: PropertiesPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

function PropertiesPage() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)

	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}

	const enabledModules = (settings?.enabled_modules as string[]) ?? ['work']
	const objectTypes = useMemo(
		() => getEnabledObjectTypeTabs(enabledModules).map((t) => t.value),
		[enabledModules],
	)
	const [activeType, setActiveType] = useState(objectTypes[0])
	const { create } = useSearch({ from: '/_authed/$workspaceId/settings/properties/' })
	const [showAdd, setShowAdd] = useState(false)
	const [newName, setNewName] = useState('')

	useEffect(() => {
		if (create) setShowAdd(true)
	}, [create])
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
			<PageHeader title="Properties" />

			{/* Object type tabs */}
			<div className="flex gap-1 mb-4">
				{objectTypes.map((type) => (
					<Button
						key={type}
						type="button"
						variant={activeType === type ? 'default' : 'secondary'}
						size="sm"
						className="capitalize"
						onClick={() => setActiveType(type)}
					>
						{type}
					</Button>
				))}
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
							to="/$workspaceId/settings/properties/$propertyName"
							params={{ workspaceId, propertyName: field.name }}
							search={{ type: activeType }}
							className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-muted/50 transition-colors"
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
		</div>
	)
}
