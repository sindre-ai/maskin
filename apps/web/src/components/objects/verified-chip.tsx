import { Badge } from '@/components/ui/badge'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { BadgeCheck, ShieldCheck } from 'lucide-react'
import { useCallback } from 'react'

// A knowledge object counts as a Knowledge Author write when its `provenance`
// metadata field lists "writer" as one of its comma-separated tags. This is
// the same field T3 exposed as a compact chip column on the Objects page.
export function isKnowledgeAuthorWrite(object: ObjectResponse): boolean {
	if (object.type !== 'knowledge') return false
	const raw = (object.metadata as Record<string, unknown> | null | undefined)?.provenance
	if (typeof raw !== 'string') return false
	return raw
		.split(',')
		.map((tag) => tag.trim().toLowerCase())
		.includes('writer')
}

export function isObjectVerified(object: ObjectResponse): boolean {
	const meta = object.metadata as Record<string, unknown> | null | undefined
	if (!meta) return false
	return typeof meta.verified_by === 'string' && meta.verified_by.length > 0
}

// Current member is allowed to stamp when they are a human admin/owner of
// the workspace. Server enforces the same rule — this gate purely controls
// visibility of the stamp control so agents and read-only members don't see
// a button that would 403.
function findCurrentMember(members: MemberResponse[] | undefined): MemberResponse | null {
	const currentActorId = getStoredActor()?.id
	if (!currentActorId || !members) return null
	return members.find((m) => m.actorId === currentActorId) ?? null
}

export function canStampVerification(members: MemberResponse[] | undefined): boolean {
	const member = findCurrentMember(members)
	if (!member) return false
	if (member.type === 'agent') return false
	return member.role === 'admin' || member.role === 'owner'
}

interface VerifiedChipProps {
	object: ObjectResponse
	members: MemberResponse[] | undefined
	onToggle: (verified: boolean) => void
	isPending?: boolean
}

// Renders next to the type/status chips in the object-document header. Two
// visual states: unverified (subtle outline) and verified (filled success
// tone). Humans with admin/owner role get a clickable toggle; everyone else
// sees the same chip as a read-only badge.
export function VerifiedChip({ object, members, onToggle, isPending }: VerifiedChipProps) {
	const verified = isObjectVerified(object)
	const canStamp = canStampVerification(members)

	const handleClick = useCallback(() => {
		if (!canStamp || isPending) return
		onToggle(!verified)
	}, [canStamp, isPending, onToggle, verified])

	const label = verified ? 'Verified' : 'Unverified'
	const Icon = verified ? BadgeCheck : ShieldCheck

	const chipClass = cn(
		'gap-1 px-2 py-0.5 text-[11px] font-medium',
		verified
			? 'border-transparent bg-success/15 text-success hover:bg-success/25'
			: 'bg-transparent text-muted-foreground hover:bg-secondary/60',
		!canStamp && 'cursor-default hover:bg-transparent',
		verified && !canStamp && 'hover:bg-success/15',
	)

	const commonProps = {
		'aria-label': verified ? 'Verified — click to remove' : 'Not verified — click to stamp',
		title: verified ? 'Verified by a workspace admin/owner' : 'Not yet verified',
	}

	if (!canStamp) {
		return (
			<Badge variant="outline" className={chipClass} {...commonProps}>
				<Icon size={12} aria-hidden="true" />
				{label}
			</Badge>
		)
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={isPending}
			className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-full"
			aria-pressed={verified}
			{...commonProps}
		>
			<Badge variant="outline" className={chipClass}>
				<Icon size={12} aria-hidden="true" />
				{label}
			</Badge>
		</button>
	)
}
