import { Button } from '@/components/ui/button'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { PanelRight } from 'lucide-react'
import { useCallback, useState } from 'react'
import { SubscribeToggle } from '../shared/subscribe-toggle'
import { TypeBadge } from '../shared/type-badge'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { OwnerSelect, StatusSelect } from './property-selects'

interface ObjectDetailHeaderProps {
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
 * The page-level bar above the document (mockup 1033–1039): the properties
 * toggle and overflow menu, right-aligned over one hairline rule. The document
 * scrolls in its own region below it.
 *
 * The mockup puts an `Objects › <name>` crumb at the left of this bar, but the
 * shared nav row already renders that chain for detail routes
 * (`layout/header.tsx`'s `routeConfig`). Two competing breadcrumbs is worse
 * than one in the "wrong" place, so the nav keeps the chain and this bar
 * carries actions only — which is also why this route publishes no `title`.
 */
export function ObjectDetailHeader({
	object,
	workspaceId,
	onDeleteRequest,
	onArchiveRequest,
	onTogglePropertiesRequest,
	propertiesOpen,
}: ObjectDetailHeaderProps) {
	const [menuOpen, setMenuOpen] = useState(false)

	return (
		<div className="flex flex-none flex-wrap items-center justify-end gap-2 border-b border-border pb-3">
			<SubscribeToggle
				workspaceId={workspaceId}
				entityType="object"
				entityId={object.id}
				isSubscribed={object.is_subscribed}
				className="mr-1"
			/>
			{onTogglePropertiesRequest && (
				<Button
					variant="outline"
					size="icon"
					className="shrink-0"
					onClick={onTogglePropertiesRequest}
					aria-label="Properties"
					aria-expanded={propertiesOpen}
				>
					<PanelRight size={15} />
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
 * Type tag, status chip and driver chip, then the title (mockup 1056–1096).
 * Lives inside the reader column, not the bar — the mockup reads type/state/
 * owner before the h1. Hosts [data-hero-status-trigger] for the sticky-nav
 * sprout-back.
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
		<div className="mb-3">
			<div className="mb-2.5 flex flex-wrap items-center gap-2">
				{/* The type's glyph leads the meta row (mockup 1058 `odTypeIcon`). */}
				<TypeBadge type={object.type} variant="tile" />
				<TypeBadge type={object.type} />
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
					className="w-full resize-none overflow-hidden border-none bg-transparent p-0 text-[clamp(20px,2.4vw,25px)] font-bold leading-tight tracking-[-0.02em] text-foreground outline-none focus:outline-none"
					ref={(el) => {
						if (el) {
							el.style.height = 'auto'
							el.style.height = `${el.scrollHeight}px`
						}
					}}
				/>
			) : (
				<h1 className="text-[clamp(20px,2.4vw,25px)] font-bold leading-tight tracking-[-0.02em] text-foreground">
					{object.title ?? 'Untitled'}
				</h1>
			)}
		</div>
	)
}
