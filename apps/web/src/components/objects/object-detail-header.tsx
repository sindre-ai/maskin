import { NewMenu } from '@/components/shared/new-menu'
import { Button } from '@/components/ui/button'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor, getTypeColor, statusLabel, typeIcons, typeLabel } from '@/lib/constants'
import { useNavigate } from '@tanstack/react-router'
import { PanelRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { OwnerSelect, StatusSelect } from './property-selects'

interface ObjectDetailBarActionsProps {
	object: ObjectResponse
	workspaceId: string
	onDeleteRequest: () => void
	onArchiveRequest?: () => void
	/** Opens/closes the properties drawer (mockup 1037). Rendered only when the
	 *  host wires it — the MCP-app embed has no drawer. */
	onTogglePropertiesRequest?: () => void
	propertiesOpen?: boolean
}

/**
 * The two icon affordances the detail bar carries (mockup 1036–1039): the
 * properties-drawer toggle and the overflow menu, both 28px squares on a
 * hairline. The bar itself — `Objects › <name>` — is the shared nav's detail
 * variant, which this cluster is published into as `actions`.
 */
export function ObjectDetailBarActions({
	object,
	workspaceId,
	onDeleteRequest,
	onArchiveRequest,
	onTogglePropertiesRequest,
	propertiesOpen,
}: ObjectDetailBarActionsProps) {
	const [menuOpen, setMenuOpen] = useState(false)

	return (
		// Mockup order (919–950): the overflow menu, then the drawer toggle. The
		// split New button follows, rendered by the shared nav so this route uses
		// the same one as every other screen.
		<div className="flex shrink-0 items-center gap-2">
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={onDeleteRequest}
				onArchiveRequest={onArchiveRequest}
				workspaceId={workspaceId}
				open={menuOpen}
				onOpenChange={setMenuOpen}
			/>
			{onTogglePropertiesRequest && (
				<Button
					variant="outline"
					size="icon"
					className={cn(
						'size-7 shrink-0 rounded-lg text-muted-foreground',
						propertiesOpen && 'bg-secondary text-foreground',
					)}
					onClick={onTogglePropertiesRequest}
					aria-label="Properties"
					aria-expanded={propertiesOpen}
				>
					<PanelRight className="size-3.5" />
				</Button>
			)}
		</div>
	)
}

/**
 * Type glyph and word, status chip and driver chip on one 11.5px meta line,
 * then the title (mockup 1056–1096). Lives inside the reader column, not the
 * bar — the mockup reads type/state/owner before the h1. Hosts
 * [data-hero-status-trigger] for the sticky-nav sprout-back.
 */
/**
 * The read-only reading of the status pill (mockup `odSkCaret` is empty when a
 * type carries no schema statuses): same shape as the picker, no caret, not a
 * control — the object still says what state it is in.
 */
function StatusPill({ status }: { status: string }) {
	const tone = getStatusColor(status)
	return (
		<span className="inline-flex items-center gap-1.5 rounded-[7px] border border-transparent px-2 py-[3px]">
			<span className={cn('shrink-0', tone.text)}>
				<span aria-hidden="true" className="block size-[7px] rounded-full bg-current" />
			</span>
			<span className="text-muted-foreground">Status</span>
			<span className="font-semibold capitalize text-secondary-foreground">
				{statusLabel(status)}
			</span>
		</span>
	)
}

const TITLE_CLASS =
	'text-[clamp(20px,2.4vw,25px)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground'

export function ObjectDetailIdentity({
	object,
	statuses,
	members,
	onStatusChange,
	onDriverChange,
	onTitleChange,
}: {
	object: ObjectResponse
	statuses: string[]
	members: MemberResponse[]
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
	/** Wire this to make the title editable in place. Omitted by read-only
	 *  hosts (the MCP-app embed), which keeps the plain heading. */
	onTitleChange?: (title: string) => void
}) {
	const Icon = typeIcons[object.type]
	const typeColor = getTypeColor(object.type)

	// Click-to-edit, the same shape the body uses: the heading stays a real
	// <h1> at rest and only becomes a field once you ask for it, so the
	// document reads as the mockup draws it and still renames in place.
	const [editingTitle, setEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState(object.title ?? '')
	useEffect(() => {
		if (!editingTitle) setTitleDraft(object.title ?? '')
	}, [object.title, editingTitle])

	// A route swap reuses this instance, and the effect above deliberately holds
	// the draft while you are typing — so without this an in-flight edit would
	// survive the swap and blur would commit the previous object's text onto the
	// new one. Leaving edit mode as well means the swap lands on the heading.
	const [trackedObjectId, setTrackedObjectId] = useState(object.id)
	if (trackedObjectId !== object.id) {
		setTrackedObjectId(object.id)
		setTitleDraft(object.title ?? '')
		setEditingTitle(false)
	}

	const commitTitle = () => {
		setEditingTitle(false)
		const next = titleDraft.trim()
		if (next && next !== object.title) onTitleChange?.(next)
		else setTitleDraft(object.title ?? '')
	}

	return (
		<div>
			<div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
				{/* The type's glyph leads the meta row (mockup 1058 `odTypeIcon`) —
				    a 13px stroke in the type's own colour, not a filled tile. */}
				{Icon && <Icon aria-hidden="true" className={cn('size-[13px] shrink-0', typeColor.text)} />}
				<span>{typeLabel(object.type)}</span>
				{statuses.length > 0 ? (
					<StatusSelect
						current={object.status}
						options={statuses}
						onChange={onStatusChange}
						variant="chip"
						heroAnchor
					/>
				) : (
					object.status && <StatusPill status={object.status} />
				)}
				<OwnerSelect
					members={members}
					currentOwnerId={object.driver ?? null}
					onChange={onDriverChange}
					variant="chip"
				/>
			</div>

			{editingTitle ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: the field only exists once the reader asks to rename
					autoFocus
					value={titleDraft}
					aria-label="Object title"
					onChange={(e) => {
						setTitleDraft(e.target.value)
					}}
					onBlur={commitTitle}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
							e.currentTarget.blur()
						}
						if (e.key === 'Escape') {
							setTitleDraft(object.title ?? '')
							setEditingTitle(false)
						}
					}}
					className={cn(TITLE_CLASS, 'mt-2.5 w-full border-none bg-transparent p-0 outline-none')}
				/>
			) : (
				<h1
					className={cn(
						'mt-2.5',
						TITLE_CLASS,
						onTitleChange && 'cursor-text rounded-lg transition-colors hover:bg-muted/60',
					)}
					title={onTitleChange ? 'Click to edit' : undefined}
					tabIndex={onTitleChange ? 0 : undefined}
					onClick={onTitleChange ? () => setEditingTitle(true) : undefined}
					onKeyDown={
						onTitleChange
							? (e) => {
									if (e.key !== 'Enter' && e.key !== ' ') return
									e.preventDefault()
									setEditingTitle(true)
								}
							: undefined
					}
				>
					{object.title ?? 'Untitled'}
				</h1>
			)}
		</div>
	)
}
