import { ObjectReference } from '@/components/shared/object-reference'
import { TypeBadge } from '@/components/shared/type-badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { ProducedFileItem, ProducedObjectItem } from '@/hooks/use-conversation-produced'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { Button } from '../ui/button'

interface ProducedPaneProps {
	workspaceId: string
	producedObjects: ProducedObjectItem[]
	producedFiles: ProducedFileItem[]
	isLoading: boolean
	/** Mobile bottom-sheet + right-rail both render the pane through the same
	 *  content component; only the shell differs, so the close button is only
	 *  rendered when the caller wants it (the right-rail keeps the header
	 *  toggle as the close affordance; the bottom-sheet needs an in-sheet X
	 *  because the toggle isn't reachable behind the overlay). */
	onClose?: () => void
	className?: string
}

/**
 * S2 · The right-rail pane on chat detail (bet 34706e2f, task 5).
 *
 * Renders everything produced downstream of a chat's sessions — objects first,
 * then files — with the Designer spec §6 copy verbatim, a `--surface-sunken`
 * background, and a `System-tracked · not editable` footer that hard-carves
 * the "system writes, users read" contract from the bet spec's §No-gos.
 *
 * States: default (both groups render), empty (dashed-border card), loading
 * (skeleton rows). Group headings hide with a `null` return when their count is
 * zero, so a chat with only files never shows an empty `Objects · 0` line and
 * vice versa (matches the Session Sheet's Files sub-group hide-when-zero rule
 * called out in the acceptance criteria).
 */
export function ProducedPane({
	workspaceId,
	producedObjects,
	producedFiles,
	isLoading,
	onClose,
	className,
}: ProducedPaneProps) {
	const total = producedObjects.length + producedFiles.length
	const isEmpty = !isLoading && total === 0

	return (
		<div
			className={cn('flex h-full min-h-0 w-full flex-col bg-surface-sunken', className)}
			aria-label="Produced items"
		>
			<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
				<h3 className="text-[13px] font-semibold text-foreground">Produced</h3>
				{onClose ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={onClose}
						aria-label="Close Produced pane"
					>
						<X size={14} />
					</Button>
				) : null}
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				{isLoading ? (
					<ProducedSkeletons />
				) : isEmpty ? (
					<ProducedEmpty />
				) : (
					<>
						<ProducedObjectsGroup workspaceId={workspaceId} items={producedObjects} />
						<ProducedFilesGroup workspaceId={workspaceId} items={producedFiles} />
					</>
				)}
			</div>

			<p className="shrink-0 border-t border-border px-4 py-2 text-[10.5px] font-mono uppercase tracking-[0.09em] text-muted-foreground">
				System-tracked · not editable
			</p>
		</div>
	)
}

function ProducedObjectsGroup({
	workspaceId,
	items,
}: { workspaceId: string; items: ProducedObjectItem[] }) {
	if (items.length === 0) return null
	return (
		<section aria-label={`Objects · ${items.length}`}>
			<h4 className="mb-1.5 text-[10.5px] font-mono uppercase tracking-[0.09em] text-muted-foreground">
				Objects · {items.length}
			</h4>
			<ul className="flex flex-col gap-1">
				{items.map((obj) => (
					<li key={obj.entityId}>
						<div className="rounded-md border border-border bg-surface-sunken transition-colors hover:border-[color:var(--border-hover)] hover:bg-background hover:shadow-xs">
							<ObjectReference objectId={obj.entityId} workspaceId={workspaceId} variant="block" />
						</div>
					</li>
				))}
			</ul>
		</section>
	)
}

function ProducedFilesGroup({
	workspaceId,
	items,
}: { workspaceId: string; items: ProducedFileItem[] }) {
	if (items.length === 0) return null
	return (
		<section aria-label={`Files · ${items.length}`}>
			<h4 className="mb-1.5 text-[10.5px] font-mono uppercase tracking-[0.09em] text-muted-foreground">
				Files · {items.length}
			</h4>
			<ul className="flex flex-col gap-1">
				{items.map((file) => (
					<li key={file.fileId}>
						<FileCard workspaceId={workspaceId} file={file} />
					</li>
				))}
			</ul>
		</section>
	)
}

function FileCard({ workspaceId, file }: { workspaceId: string; file: ProducedFileItem }) {
	return (
		<Link
			to="/$workspaceId/files/$fileId"
			params={{ workspaceId, fileId: file.fileId }}
			className="flex items-center gap-2.5 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-[13px] transition-colors hover:border-[color:var(--border-hover)] hover:bg-background hover:shadow-xs"
		>
			<TypeBadge type="file" variant="tile" size="sm" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-foreground">{file.name ?? 'Untitled file'}</span>
				<span className="truncate text-[10.5px] font-mono text-muted-foreground">
					{[file.mimeType, file.sizeBytes != null ? formatSize(file.sizeBytes) : null]
						.filter(Boolean)
						.join(' · ')}
				</span>
			</span>
		</Link>
	)
}

const SKELETON_ROWS = ['s-0', 's-1', 's-2', 's-3']
function ProducedSkeletons() {
	return (
		<div className="flex flex-col gap-2">
			{SKELETON_ROWS.map((key) => (
				<Skeleton key={key} className="h-14 w-full rounded-md" />
			))}
		</div>
	)
}

function ProducedEmpty() {
	return (
		<div className="rounded-lg border border-dashed border-border bg-background px-4 py-6 text-center">
			<p className="text-[13px] font-semibold text-foreground">Nothing produced yet</p>
			<p className="mt-1.5 text-[12px] leading-[1.5] text-muted-foreground">
				This chat hasn't spawned any sessions. When an agent creates an object or file from a
				message here, it'll appear in this list — no wiring required.
			</p>
		</div>
	)
}
