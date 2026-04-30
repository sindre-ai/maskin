import { Button } from '@/components/ui/button'
import { useEffect, useMemo, useState } from 'react'
import { SchemaForm } from '../shared/schema-form'
import { useWorkspaceSchema } from '../shared/use-workspace-schema'

interface MetadataEditorProps {
	objectId: string
	objectType: string
	workspaceId: string | undefined
	metadata: Record<string, unknown> | null
	onSubmit: (next: Record<string, unknown>) => Promise<void>
}

/**
 * Metadata edit panel for the Objects card. Renders the schema-driven
 * `<SchemaForm>` against the object's type so every enum field hydrates from
 * `get_workspace_schema`, plus an explicit save/cancel pair so partial edits
 * never auto-fire `update_objects`.
 *
 * The panel is read-only by default and toggled into an editor on demand —
 * matching the inline-edit pattern used by the web app's metadata-properties
 * view, but adapted to the card's smaller surface and the SchemaForm primitive.
 */
export function MetadataEditor({
	objectId,
	objectType,
	workspaceId,
	metadata,
	onSubmit,
}: MetadataEditorProps) {
	const { schema, loading } = useWorkspaceSchema(workspaceId)
	const fields = schema?.types[objectType]?.fields ?? []

	const [editing, setEditing] = useState(false)
	const initial = useMemo(() => ({ ...(metadata ?? {}) }), [metadata])
	const [draft, setDraft] = useState<Record<string, unknown>>(initial)

	// Reset the editor draft when the underlying object id changes (e.g. card
	// rebound to a new tool result) or when the persisted metadata changes
	// without an in-flight edit.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only when the source object/metadata changes.
	useEffect(() => {
		if (!editing) setDraft(initial)
	}, [objectId, initial, editing])

	if (loading && !schema) {
		return <p className="text-xs text-muted-foreground">Loading schema…</p>
	}

	if (fields.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">No metadata fields defined for {objectType}.</p>
		)
	}

	if (!editing) {
		const entries = fields
			.map((f) => [f.name, metadata?.[f.name]] as const)
			.filter(([, v]) => v !== undefined && v !== null && v !== '')
		return (
			<div className="space-y-2">
				{entries.length === 0 ? (
					<p className="text-xs text-muted-foreground">No metadata set.</p>
				) : (
					<dl className="space-y-1">
						{entries.map(([name, value]) => (
							<div key={name} className="flex gap-2 text-xs">
								<dt className="w-28 shrink-0 capitalize text-muted-foreground">
									{name.replace(/_/g, ' ')}
								</dt>
								<dd className="text-foreground break-words">{formatDisplay(value)}</dd>
							</div>
						))}
					</dl>
				)}
				<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
					Edit metadata
				</Button>
			</div>
		)
	}

	const handleSubmit = async (next: Record<string, unknown>) => {
		// Drop empty-string values so we don't overwrite "unset" with "".
		const clean: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(next)) {
			if (v === '' || v === undefined) continue
			clean[k] = v
		}
		await onSubmit(clean)
		setEditing(false)
	}

	return (
		<div className="space-y-2">
			<SchemaForm
				objectType={objectType}
				values={draft}
				onChange={setDraft}
				onSubmit={handleSubmit}
				workspaceId={workspaceId}
				submitLabel="Save metadata"
			/>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					setDraft(initial)
					setEditing(false)
				}}
			>
				Cancel
			</Button>
		</div>
	)
}

function formatDisplay(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'boolean') return value ? 'Yes' : 'No'
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value)
		} catch {
			return String(value)
		}
	}
	return String(value)
}
