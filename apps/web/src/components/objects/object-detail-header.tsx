import { EditableTitle } from '@/components/shared/editable-title'
import { Button } from '@/components/ui/button'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getStatusColor, getTypeColor, statusLabel, typeIcons, typeLabel } from '@/lib/constants'
import { Link } from '@tanstack/react-router'
import { PanelRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { DetailMetaStar } from './detail-meta-row'
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

/**
 * D6 — the amber `⏸ PAUSED · UPGRADE` chip on the object-detail meta row.
 * Rendered only when the workspace-scoped `useUsageState()` selector returns
 * `credits_state === 'empty'`. Top-up is closed, so the chip says Upgrade like
 * the left-nav trial card and opens the same place (Billing), with the percent
 * flag on or off. `role="status"` + polite live region reads the flip on first
 * render; SSE-driven billing invalidation (session lifecycle events) drives the
 * subsequent re-renders without a page reload.
 */
export function PausedNoCreditsChip({ workspaceId }: { workspaceId: string }) {
	return (
		<Link
			to="/$workspaceId/settings/billing"
			params={{ workspaceId }}
			// biome-ignore lint/a11y/useSemanticElements: the chip is also a link,
			// so it must remain an <a>; role=status carries the D6 accessibility
			// contract without changing the element.
			role="status"
			aria-live="polite"
			aria-label="Paused. Upgrade your plan in Billing."
			title="New sessions are paused. Upgrade your plan in Billing."
			className={cn(
				'inline-flex items-center gap-1 rounded-[7px] px-2 py-[3px] font-semibold',
				// Amber chip, no border — matches the retired trial-expired banner
				// tone (bg-warning/10 + text-warning) so both credit surfaces speak
				// with one voice.
				'bg-warning/15 text-warning transition-colors hover:bg-warning/25',
			)}
		>
			{/* The leading U+23F8 double-vertical-bar stays inline with the label so
			    screen readers announce the aria-label rather than the glyph. */}
			<span aria-hidden="true">⏸</span>
			<span>PAUSED · UPGRADE</span>
		</Link>
	)
}

/**
 * The status and owner pills: the shared dropdown pills on the identity's meta
 * line. A host that draws them elsewhere turns them off with `showPills`.
 */
export function ObjectDetailPills({
	object,
	statuses,
	members,
	workspaceId,
	creditsState,
	onStatusChange,
	onDriverChange,
}: {
	object: ObjectResponse
	statuses: string[]
	members: MemberResponse[]
	workspaceId: string
	creditsState?: 'empty' | 'ok' | 'unknown'
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
}) {
	return (
		<>
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
			{creditsState === 'empty' && <PausedNoCreditsChip workspaceId={workspaceId} />}
			<OwnerSelect
				members={members}
				currentOwnerId={object.driver ?? null}
				onChange={onDriverChange}
				variant="chip"
			/>
		</>
	)
}

export function ObjectDetailIdentity({
	object,
	statuses,
	members,
	workspaceId,
	creditsState,
	onStatusChange,
	onDriverChange,
	onTitleChange,
	showPills = true,
	metaEnd,
}: {
	/** Turns the status and owner pills off on the meta line, for a host that draws them itself. */
	showPills?: boolean
	/** Sits after the pills on the meta line (the page puts the quiet Origin text here). It drops
	 *  to its own line when the row has no room. */
	metaEnd?: ReactNode
	object: ObjectResponse
	statuses: string[]
	members: MemberResponse[]
	/** Workspace ID the D6 credits chip links back to for the billing anchor. */
	workspaceId: string
	/** D6: when `'empty'`, renders the amber `⏸ PAUSED · UPGRADE` chip
	 *  immediately after the status chip. Any other value renders nothing. */
	creditsState?: 'empty' | 'ok' | 'unknown'
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
	/** Wire this to make the title editable in place. Omitted by read-only
	 *  hosts (the MCP-app embed), which keeps the plain heading. */
	// May return a promise. If it rejects, the field is reopened with the
	// user's draft intact rather than silently reverting to the old title.
	onTitleChange?: (title: string) => unknown
}) {
	const Icon = typeIcons[object.type]
	const typeColor = getTypeColor(object.type)

	return (
		<div>
			<EditableTitle
				value={object.title}
				entityId={object.id}
				onChange={onTitleChange}
				ariaLabel="Item title"
				className="text-[clamp(24px,3vw,30px)]"
			/>

			{/* One meta line under the title: star, type, status, owner, then origin. The first
			    four stay together and wrap only on a phone; origin drops below them when the row
			    is full. */}
			<div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
				<div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:shrink-0">
					{/* SPEC §D5: the star leads the meta row. The -3px lines its 14px glyph up
					    with the title's left edge. */}
					<span className="-ml-[3px] inline-flex">
						<DetailMetaStar objectId={object.id} />
					</span>
					{/* The type's glyph (mockup 1058 `odTypeIcon`) — a 13px stroke in the type's
					    own colour, not a filled tile. */}
					{Icon && (
						<Icon aria-hidden="true" className={cn('size-[13px] shrink-0', typeColor.text)} />
					)}
					<span>{typeLabel(object.type)}</span>
					{showPills && (
						<ObjectDetailPills
							object={object}
							statuses={statuses}
							members={members}
							workspaceId={workspaceId}
							creditsState={creditsState}
							onStatusChange={onStatusChange}
							onDriverChange={onDriverChange}
						/>
					)}
				</div>
				{metaEnd}
			</div>
		</div>
	)
}
