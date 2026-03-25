import { useUpdateObject } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'

export function MetadataBadgesView({
	object,
	onRemove,
}: {
	object: ObjectResponse
	onRemove?: (key: string) => void
}) {
	const metadata = object.metadata
	if (!metadata) return null

	const entries = Object.entries(metadata).filter(([key]) => !key.startsWith('_'))
	if (entries.length === 0) return null

	return (
		<div className="flex flex-wrap gap-1.5">
			{entries.map(([key, value]) => (
				<span
					key={key}
					className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground group"
				>
					<span className="text-muted-foreground">{key}:</span>
					<span>{formatValue(value)}</span>
					{onRemove && (
						<button
							type="button"
							className="text-muted-foreground hover:text-error opacity-0 group-hover:opacity-100 transition-opacity ml-0.5"
							onClick={() => onRemove(key)}
							title="Remove field"
						>
							×
						</button>
					)}
				</span>
			))}
		</div>
	)
}

export function MetadataBadges({
	object,
	workspaceId,
}: {
	object: ObjectResponse
	workspaceId: string
}) {
	const updateObject = useUpdateObject(workspaceId)

	const handleRemove = (key: string) => {
		const next = { ...object.metadata }
		delete next[key]
		updateObject.mutate({ id: object.id, data: { metadata: next } })
	}

	return <MetadataBadgesView object={object} onRemove={handleRemove} />
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'boolean') return value ? 'Yes' : 'No'
	if (value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))) {
		try {
			return new Date(value as string).toLocaleDateString()
		} catch {
			return String(value)
		}
	}
	return String(value)
}
