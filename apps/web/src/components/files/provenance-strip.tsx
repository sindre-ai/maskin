import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import type { AttachingObject, ProvenanceResolution } from '@/lib/viewer-provenance'
import { pickTarget, resolveProvenance } from '@/lib/viewer-provenance'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useMemo } from 'react'

// The strip renders one row under the top bar. Its six shapes come from
// `resolveProvenance` (see viewer-provenance.ts §The 6 variants) plus the
// agent-attached-human-driver special: the label carries the driver type so
// the review panel foot can render the correct post-send state ("🔒 Awaiting
// agent response" for an agent driver, plain "Sent · <name>" for a human).
//
// Everything visible on this strip is derived from `attachers` — the strip
// never fetches; the route feeds it a stable array. The reason the resolver
// is a pure function is exactly this: the same `attachers` fixture drives
// both the component's render and its dedicated unit tests.

export interface ProvenanceStripProps {
	workspaceId: string
	attachers: AttachingObject[]
	// The N-attachers "many" variant needs the user to pick before Send
	// enables. The route owns the picked target so the strip's Send button
	// can enable in sync with the panel's Send button — both read from the
	// same resolved state.
	selectedTargetId: string | null
	onSelectTarget: (targetId: string | null) => void
}

export function ProvenanceStrip({
	workspaceId,
	attachers,
	selectedTargetId,
	onSelectTarget,
}: ProvenanceStripProps) {
	const resolved = useMemo<ProvenanceResolution>(() => {
		const base = resolveProvenance(attachers)
		// If the caller already picked (persisted in the URL or panel state),
		// re-apply so the strip renders the picked target's title.
		if (selectedTargetId) return pickTarget(base, selectedTargetId)
		return base
	}, [attachers, selectedTargetId])

	// Variant #4 — zero attaching objects: the strip is intentionally absent.
	// A visible "This file isn't attached to anything" affordance would push
	// the stage down for the common direct-link case (e.g. the ⋯ Copy-link
	// return path); the Send-round button in the panel foot already carries
	// the tooltip that explains it.
	if (resolved.strip.kind === 'hidden') return null

	return (
		<div
			data-viewer-provenance-strip
			data-variant={resolved.variant}
			className={cn(
				'flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs',
				(resolved.variant === 'archived' || resolved.variant === 'orphaned') &&
					'text-muted-foreground',
			)}
		>
			{renderStripContent({ workspaceId, resolved, selectedTargetId, onSelectTarget })}
		</div>
	)
}

function renderStripContent({
	workspaceId,
	resolved,
	selectedTargetId,
	onSelectTarget,
}: {
	workspaceId: string
	resolved: ProvenanceResolution
	selectedTargetId: string | null
	onSelectTarget: (targetId: string | null) => void
}) {
	// Variant #1 — one attaching object.
	if (resolved.variant === 'single') {
		const [only] = resolved.strip.objects
		return (
			<>
				<span className="text-muted-foreground">Attached to</span>
				<AttacherLink workspaceId={workspaceId} attacher={only} />
				<span className="text-muted-foreground">·</span>
				<span className="text-muted-foreground">{only.attacherName}</span>
				<span className="text-muted-foreground">·</span>
				<span data-testid="strip-attached-at">
					<RelativeTime date={only.attachedAt} className="text-muted-foreground" />
				</span>
				<DriverTypeMarker driverType={only.driverType} />
			</>
		)
	}

	// Variant #2 — two attaching objects: pick between them with Switch context.
	if (resolved.variant === 'pair') {
		const pickedId = selectedTargetId ?? resolved.defaultTarget?.id ?? null
		const picked =
			resolved.pickerOptions.find((o) => o.id === pickedId) ?? resolved.pickerOptions[0]
		const other = resolved.pickerOptions.find((o) => o.id !== picked.id) ?? null
		return (
			<>
				<span className="text-muted-foreground">Attached to</span>
				<AttacherLink workspaceId={workspaceId} attacher={picked} />
				{other && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={() => onSelectTarget(other.id)}
						aria-label={`Switch context to ${other.title}`}
					>
						Switch context
					</Button>
				)}
				<DriverTypeMarker driverType={picked.driverType} />
			</>
		)
	}

	// Variant #3 — many attaching objects: picker required before Send enables.
	if (resolved.variant === 'many') {
		const pickedId = selectedTargetId ?? null
		const picked = pickedId ? (resolved.pickerOptions.find((o) => o.id === pickedId) ?? null) : null
		return (
			<>
				<span className="text-muted-foreground">Attached to</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-6 gap-1 px-2 text-xs"
							aria-label="Pick target object for the review round"
						>
							{picked ? picked.title : `${resolved.pickerOptions.length} objects`}
							<ChevronDown size={12} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-56">
						{resolved.pickerOptions.map((option) => (
							<DropdownMenuItem
								key={option.id}
								onSelect={() => onSelectTarget(option.id)}
								className="flex items-center gap-2"
							>
								<TypeBadge type={option.type} variant="dot" />
								<span className="truncate">{option.title}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<DriverTypeMarker driverType={picked?.driverType ?? null} />
			</>
		)
	}

	// Variant #5 — every attacher archived (from the start).
	if (resolved.variant === 'archived') {
		const [archived] = resolved.strip.objects
		return (
			<>
				<span>Attached to (archived):</span>
				<AttacherLink workspaceId={workspaceId} attacher={archived} muted />
			</>
		)
	}

	// Variant #6 — attaching object archived mid-review.
	// Same visual shape as archived, but the label says "orphaned + re-attach".
	if (resolved.variant === 'orphaned') {
		const [orphan] = resolved.strip.objects
		return (
			<>
				<span>Orphaned:</span>
				<AttacherLink workspaceId={workspaceId} attacher={orphan} muted />
				<span className="text-muted-foreground">— re-attach to send</span>
			</>
		)
	}

	return null
}

function AttacherLink({
	workspaceId,
	attacher,
	muted,
}: {
	workspaceId: string
	attacher: AttachingObject
	muted?: boolean
}) {
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: attacher.id }}
			className={cn(
				'flex items-center gap-1.5 hover:underline',
				muted ? 'text-muted-foreground line-through' : 'text-foreground',
			)}
			data-testid="strip-attacher-link"
		>
			<TypeBadge type={attacher.type} variant="dot" />
			<span className="truncate">{attacher.title}</span>
		</Link>
	)
}

// Small marker: the agent-attached-human-driver special is shipped by drawing
// the driver-type tag inline, so the panel foot (which reads the same field)
// stays in sync. Human-driver → no marker (default). Agent-driver → the agent
// pill so the reviewer knows the Send will land on an agent's For You card.
function DriverTypeMarker({
	driverType,
}: {
	driverType: 'human' | 'agent' | null
}) {
	if (driverType !== 'agent') return null
	return (
		<span
			data-testid="strip-agent-driver-marker"
			className="ml-auto rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground"
		>
			Agent driver
		</span>
	)
}
