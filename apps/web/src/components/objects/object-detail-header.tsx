import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { TypeBadge } from '../shared/type-badge'
import { AuxiliaryActionMenu } from './auxiliary-action-menu'
import { OwnerSelect, StatusSelect } from './property-selects'

interface ObjectDetailHeaderProps {
	object: ObjectResponse
	workspaceId: string
	statuses: string[]
	members: MemberResponse[]
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
	onDeleteRequest: () => void
	onArchiveRequest?: () => void
}

export function ObjectDetailHeader({
	object,
	workspaceId,
	statuses,
	members,
	onStatusChange,
	onDriverChange,
	onDeleteRequest,
	onArchiveRequest,
}: ObjectDetailHeaderProps) {
	const [menuOpen, setMenuOpen] = useState(false)

	return (
		<div className="mb-8">
			<div className="mb-3 flex items-center justify-between gap-2">
				<Breadcrumb className="min-w-0">
					<BreadcrumbList className="flex-nowrap">
						<BreadcrumbItem className="shrink-0">
							<BreadcrumbLink asChild>
								<Link
									to="/$workspaceId/objects"
									params={{ workspaceId }}
									search={{
										type: undefined,
										status: undefined,
										driver: undefined,
										sort: 'createdAt',
										order: 'desc',
										q: undefined,
										groupBy: undefined,
										ids: undefined,
										includeArchived: undefined,
									}}
								>
									Objects
								</Link>
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem className="min-w-0">
							<BreadcrumbPage className="truncate">{object.title ?? 'Untitled'}</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<AuxiliaryActionMenu
					object={object}
					onDeleteRequest={onDeleteRequest}
					onArchiveRequest={onArchiveRequest}
					workspaceId={workspaceId}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					statuses={statuses}
					members={members}
					currentDriverId={object.driver ?? null}
					onStatusChange={onStatusChange}
					onDriverChange={onDriverChange}
				/>
			</div>

			{/* Identity row — type tag, status dropdown, driver picker hoisted above
			    the title so type/state/owner are readable before the h1. Hosts
			    [data-hero-status-trigger] for the sticky-nav sprout-back. */}
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<TypeBadge type={object.type} />
				<StatusSelect
					current={object.status}
					options={statuses}
					onChange={onStatusChange}
					heroAnchor
				/>
				<OwnerSelect
					members={members}
					currentOwnerId={object.driver ?? null}
					onChange={onDriverChange}
				/>
			</div>

			<h1 className="text-title font-semibold leading-tight text-foreground">
				{object.title ?? 'Untitled'}
			</h1>
		</div>
	)
}
