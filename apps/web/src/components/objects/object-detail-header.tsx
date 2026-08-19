import { Button } from '@/components/ui/button'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getTypeColor, typeIcons, typeLabel } from '@/lib/constants'
import { PanelRight } from 'lucide-react'
import { useCallback, useState } from 'react'
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
		<div className="flex shrink-0 items-center gap-2">
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
			<AuxiliaryActionMenu
				object={object}
				onDeleteRequest={onDeleteRequest}
				onArchiveRequest={onArchiveRequest}
				workspaceId={workspaceId}
				open={menuOpen}
				onOpenChange={setMenuOpen}
			/>
		</div>
	)
}

/**
 * Type glyph and word, status chip and driver chip on one 11.5px meta line,
 * then the title (mockup 1056–1096). Lives inside the reader column, not the
 * bar — the mockup reads type/state/owner before the h1. Hosts
 * [data-hero-status-trigger] for the sticky-nav sprout-back.
 */
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
	/** Commits a renamed title on blur. Omitted by read-only hosts (the MCP-app
	 *  embed), which keeps the plain `h1`. */
	onTitleChange?: (title: string) => void
}) {
	const Icon = typeIcons[object.type]
	const typeColor = getTypeColor(object.type)

	const [titleDraft, setTitleDraft] = useState(object.title ?? '')
	// Reset the draft when the route swaps to a different object — this instance
	// is reused across param changes, so the useState initializer alone would
	// leave the textarea stuck on the previous title. Same guard the retired
	// document used.
	const [trackedObjectId, setTrackedObjectId] = useState(object.id)
	if (trackedObjectId !== object.id) {
		setTrackedObjectId(object.id)
		setTitleDraft(object.title ?? '')
	}

	const handleTitleBlur = useCallback(() => {
		if (onTitleChange && titleDraft !== (object.title ?? '')) onTitleChange(titleDraft)
	}, [titleDraft, object.title, onTitleChange])

	return (
		<div>
			<div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
				{/* The type's glyph leads the meta row (mockup 1058 `odTypeIcon`) —
				    a 13px stroke in the type's own colour, not a filled tile. */}
				{Icon && <Icon aria-hidden="true" className={cn('size-[13px] shrink-0', typeColor.text)} />}
				<span>{typeLabel(object.type)}</span>
				{statuses.length > 0 && (
					<StatusSelect
						current={object.status}
						options={statuses}
						onChange={onStatusChange}
						variant="chip"
						heroAnchor
					/>
				)}
				<OwnerSelect
					members={members}
					currentOwnerId={object.driver ?? null}
					onChange={onDriverChange}
					variant="chip"
				/>
			</div>

			{onTitleChange ? (
				<textarea
					value={titleDraft}
					aria-label="Object title"
					onChange={(e) => {
						setTitleDraft(e.target.value)
						e.target.style.height = 'auto'
						e.target.style.height = `${e.target.scrollHeight}px`
					}}
					onBlur={handleTitleBlur}
					onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
					placeholder="Untitled"
					rows={1}
					className="mt-2.5 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-[clamp(20px,2.4vw,25px)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground outline-none focus:outline-none"
					ref={(el) => {
						if (el) {
							el.style.height = 'auto'
							el.style.height = `${el.scrollHeight}px`
						}
					}}
				/>
			) : (
				<h1 className="mt-2.5 text-[clamp(20px,2.4vw,25px)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground">
					{object.title ?? 'Untitled'}
				</h1>
			)}
		</div>
	)
}
