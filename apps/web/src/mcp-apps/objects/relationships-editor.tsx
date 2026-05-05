import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ObjectResponse, RelationshipResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

/**
 * v1 relationship edit set per decision doc 35783ec4-b85e-4ead-98c6-2f1e40b95542.
 * Hard delete of objects and the wider mutation surface remain out of scope; we
 * accept add / remove for these three reversible relationship types only.
 */
export const V1_RELATIONSHIP_TYPES = ['relates_to', 'blocks', 'breaks_into'] as const
export type V1RelationshipType = (typeof V1_RELATIONSHIP_TYPES)[number]

interface RelationshipsEditorProps {
	objectId: string
	objectType: string
	relationships: RelationshipResponse[]
	connectedObjects: ObjectResponse[]
	onAdd: (input: {
		source_id: string
		target_id: string
		type: V1RelationshipType
	}) => Promise<void>
	onRemove: (relationshipId: string) => Promise<void>
}

interface ResolvedRelationship {
	rel: RelationshipResponse
	target: ObjectResponse | null
}

export function RelationshipsEditor({
	objectId,
	objectType,
	relationships,
	connectedObjects,
	onAdd,
	onRemove,
}: RelationshipsEditorProps) {
	const objectMap = useMemo(() => {
		const m = new Map<string, ObjectResponse>()
		for (const o of connectedObjects) m.set(o.id, o)
		return m
	}, [connectedObjects])

	const resolved: ResolvedRelationship[] = useMemo(() => {
		return relationships.map((rel) => {
			const otherId = rel.sourceId === objectId ? rel.targetId : rel.sourceId
			return { rel, target: objectMap.get(otherId) ?? null }
		})
	}, [relationships, objectId, objectMap])

	const [pendingDelete, setPendingDelete] = useState<string | null>(null)
	const [removingId, setRemovingId] = useState<string | null>(null)
	const [addOpen, setAddOpen] = useState(false)

	const handleConfirmRemove = async (id: string) => {
		setRemovingId(id)
		try {
			await onRemove(id)
			setPendingDelete(null)
		} finally {
			setRemovingId(null)
		}
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Related ({resolved.length})
				</h3>
				<div className="flex-1" />
				<Button variant="ghost" size="sm" onClick={() => setAddOpen((v) => !v)}>
					{addOpen ? 'Close' : '+ link'}
				</Button>
			</div>

			{addOpen ? (
				<AddRelationshipForm
					objectId={objectId}
					objectType={objectType}
					existingTargetIds={
						new Set(
							resolved
								.flatMap(({ rel }) => [rel.sourceId, rel.targetId])
								.filter((i) => i !== objectId),
						)
					}
					onAdd={onAdd}
					onClose={() => setAddOpen(false)}
				/>
			) : null}

			{resolved.length === 0 ? (
				<p className="text-xs text-muted-foreground">No relationships.</p>
			) : (
				<ul className="space-y-1">
					{resolved.map(({ rel, target }) => {
						const isPending = pendingDelete === rel.id
						const isRemoving = removingId === rel.id
						const direction = rel.sourceId === objectId ? '→' : '←'
						return (
							<li
								key={rel.id}
								className="flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs"
							>
								<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
									{direction} {rel.type.replace(/_/g, ' ')}
								</span>
								{target ? (
									<>
										<TypeBadge type={target.type} />
										<span className="flex-1 truncate text-foreground">
											{target.title || 'Untitled'}
										</span>
										<StatusBadge status={target.status} />
										<WebAppLink target={{ kind: 'object', id: target.id }} label="Open" />
									</>
								) : (
									<span className="flex-1 truncate font-mono text-muted-foreground">
										{(rel.sourceId === objectId ? rel.targetId : rel.sourceId).slice(0, 8)}
									</span>
								)}
								{isPending ? (
									<>
										<span className="text-destructive">Remove?</span>
										<Button
											variant="destructive"
											size="sm"
											disabled={isRemoving}
											onClick={() => handleConfirmRemove(rel.id)}
										>
											{isRemoving ? 'Removing…' : 'Confirm'}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={isRemoving}
											onClick={() => setPendingDelete(null)}
										>
											Cancel
										</Button>
									</>
								) : (
									<Button
										variant="ghost"
										size="icon"
										aria-label="Remove relationship"
										onClick={() => setPendingDelete(rel.id)}
									>
										<X className="size-3" />
									</Button>
								)}
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}

function AddRelationshipForm({
	objectId,
	objectType,
	existingTargetIds,
	onAdd,
	onClose,
}: {
	objectId: string
	objectType: string
	existingTargetIds: Set<string>
	onAdd: (input: {
		source_id: string
		target_id: string
		type: V1RelationshipType
	}) => Promise<void>
	onClose: () => void
}) {
	const [type, setType] = useState<V1RelationshipType>('relates_to')
	const [targetId, setTargetId] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const trimmed = targetId.trim()
		if (!UUID_RE.test(trimmed)) {
			setError('Target must be an object UUID')
			return
		}
		if (trimmed === objectId) {
			setError('Cannot link an object to itself')
			return
		}
		if (existingTargetIds.has(trimmed)) {
			setError('Already linked to this object')
			return
		}
		setError(null)
		setSubmitting(true)
		try {
			// objectType is forwarded by the host card via the parent's onAdd
			// callback; the form itself only needs the target UUID + relationship
			// type. Server-side `update_objects.edges` infers source_type as
			// 'object' for both ends.
			void objectType
			await onAdd({ source_id: objectId, target_id: trimmed, type })
			setTargetId('')
			onClose()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="space-y-2 rounded border border-border bg-card p-2"
			noValidate
		>
			<div className="space-y-1">
				<Label htmlFor="rel-type" className="text-xs text-muted-foreground capitalize">
					Type
				</Label>
				<Select value={type} onValueChange={(v) => setType(v as V1RelationshipType)}>
					<SelectTrigger id="rel-type">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{V1_RELATIONSHIP_TYPES.map((t) => (
							<SelectItem key={t} value={t}>
								{t.replace(/_/g, ' ')}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="space-y-1">
				<Label htmlFor="rel-target" className="text-xs text-muted-foreground capitalize">
					Target object id
				</Label>
				<Input
					id="rel-target"
					value={targetId}
					onChange={(e) => setTargetId(e.target.value)}
					placeholder="00000000-0000-0000-0000-000000000000"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? 'rel-target-err' : undefined}
				/>
			</div>
			{error ? (
				<p id="rel-target-err" className="text-xs text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex gap-2 pt-1">
				<Button type="submit" size="sm" disabled={submitting}>
					{submitting ? 'Linking…' : 'Add link'}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
					Cancel
				</Button>
			</div>
		</form>
	)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
