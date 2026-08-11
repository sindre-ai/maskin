import { OwnerSelect, StatusSelect } from '@/components/objects/property-selects'
import { TypeBadge } from '@/components/shared/type-badge'
import type { MemberResponse, ObjectResponse } from '@/lib/api'

/**
 * Identity row (type tag + status dropdown + driver picker) above the static
 * title. Matches the prototype's header stack: breadcrumb/actions live in the
 * global header, this component renders the row + h1.
 */
export function ObjectDetailHeader({
	object,
	statuses,
	members,
	onStatusChange,
	onDriverChange,
}: {
	object: ObjectResponse
	statuses: string[]
	members: MemberResponse[]
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
}) {
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<TypeBadge type={object.type} />
				<StatusSelect
					current={object.status}
					options={statuses}
					onChange={onStatusChange}
					heroAnchor
				/>
				<OwnerSelect
					members={members}
					currentOwnerId={object.driver}
					onChange={onDriverChange}
					compact
				/>
			</div>
			<h1 className="text-xl font-bold leading-tight tracking-tight text-foreground md:text-2xl">
				{object.title ?? 'Untitled'}
			</h1>
		</div>
	)
}
