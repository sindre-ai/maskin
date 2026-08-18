import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { COMMENT_MAX_REFS, type CommentRef } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

/**
 * Typed reference chips under a comment — an agent pointing at something it
 * wrote, or at a product surface it is explaining. Written by the backend as
 * `data.refs` (see `commentRefSchema`), not by the comment author's markdown,
 * so the label and the destination can never drift apart.
 *
 * A chip with a `detail` expands in place rather than navigating: first use
 * leans on this to explain Chats/Loops/Objects/Marketplace without sending the
 * reader out of the queue mid-card.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Mirrors `commentRefSchema.path` — refs come from the API, but this component
// turns them into hrefs, so the shape is re-checked rather than trusted.
const PATH_RE = /^[a-z0-9\-/]+$/

function isRef(value: unknown): value is CommentRef {
	if (typeof value !== 'object' || value === null) return false
	const ref = value as Partial<CommentRef>
	if (typeof ref.label !== 'string' || ref.label.length === 0) return false
	if (typeof ref.tag !== 'string' || ref.tag.length === 0) return false
	if (ref.kind === 'object') return typeof ref.object_id === 'string' && UUID_RE.test(ref.object_id)
	if (ref.kind === 'page') return typeof ref.path === 'string' && PATH_RE.test(ref.path)
	return false
}

export function extractRefs(event: EventResponse): CommentRef[] {
	const raw = event.data?.refs
	if (!Array.isArray(raw)) return []
	return raw.filter(isRef).slice(0, COMMENT_MAX_REFS)
}

export function hasRefs(event: EventResponse): boolean {
	if (event.action !== 'commented') return false
	return extractRefs(event).length > 0
}

interface CommentRefChipsProps {
	event: EventResponse
	className?: string
}

export function CommentRefChips({ event, className }: CommentRefChipsProps) {
	const refs = extractRefs(event)
	if (refs.length === 0) return null
	return (
		<ul
			className={cn('mt-2 flex flex-col gap-1.5', className)}
			aria-label="Referenced by this comment"
		>
			{refs.map((ref, index) => (
				<li key={`${ref.kind}:${ref.object_id ?? ref.path}:${index}`}>
					<RefChip ref_={ref} />
				</li>
			))}
		</ul>
	)
}

function RefChip({ ref_ }: { ref_: CommentRef }) {
	const { workspaceId } = useWorkspace()
	const [expanded, setExpanded] = useState(false)

	const label = (
		<>
			<span className="font-mono text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground shrink-0">
				{ref_.tag}
			</span>
			<span className="min-w-0 truncate font-medium text-foreground">{ref_.label}</span>
		</>
	)

	const shell =
		'inline-flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs transition-colors hover:border-border-strong'

	// No explainer to reveal — the chip is purely a link.
	if (!ref_.detail) {
		return (
			<RefLink ref_={ref_} workspaceId={workspaceId} className={shell}>
				{label}
				<span aria-hidden className="ml-auto shrink-0 text-muted-foreground">
					→
				</span>
			</RefLink>
		)
	}

	return (
		<div className="rounded-lg border border-border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((open) => !open)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs"
			>
				{label}
				<ChevronDown
					size={13}
					aria-hidden
					className={cn(
						'ml-auto shrink-0 text-muted-foreground transition-transform',
						expanded && 'rotate-180',
					)}
				/>
			</button>
			{expanded && (
				<div className="border-t border-border px-3 py-2.5">
					<p className="text-xs leading-relaxed text-muted-foreground">{ref_.detail}</p>
					<RefLink
						ref_={ref_}
						workspaceId={workspaceId}
						className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
					>
						Open {ref_.label} →
					</RefLink>
				</div>
			)}
		</div>
	)
}

function RefLink({
	ref_,
	workspaceId,
	className,
	children,
}: {
	ref_: CommentRef
	workspaceId: string
	className?: string
	children: React.ReactNode
}) {
	if (ref_.kind === 'object' && ref_.object_id) {
		return (
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: ref_.object_id }}
				className={className}
			>
				{children}
			</Link>
		)
	}
	const page = resolvePageRef(ref_.path)
	if (!page) {
		// An unrecognised page ref is a bug in whatever wrote the comment, not
		// something to guess a destination for — render the label, not a link.
		return <span className={className}>{children}</span>
	}
	if (page.kind === 'marketplace_loop') {
		return (
			<Link
				to="/$workspaceId/marketplace/$loopId"
				params={{ workspaceId, loopId: page.loopId }}
				className={className}
			>
				{children}
			</Link>
		)
	}
	return (
		<Link to={page.to} params={{ workspaceId }} className={className}>
			{children}
		</Link>
	)
}

/**
 * Page refs carry a workspace-relative path, but TanStack Router only accepts
 * routes it knows at build time — so the handful of paths first use can emit
 * are mapped explicitly here rather than string-concatenated into a `to`.
 */
type ResolvedPageRef =
	| { kind: 'static'; to: '/$workspaceId/chats' | '/$workspaceId/loops' | '/$workspaceId/objects' }
	| { kind: 'marketplace'; to: '/$workspaceId/marketplace' }
	| { kind: 'marketplace_loop'; loopId: string }

function resolvePageRef(path: string | undefined): ResolvedPageRef | null {
	if (!path) return null
	if (path === 'chats') return { kind: 'static', to: '/$workspaceId/chats' }
	if (path === 'loops') return { kind: 'static', to: '/$workspaceId/loops' }
	if (path === 'objects') return { kind: 'static', to: '/$workspaceId/objects' }
	if (path === 'marketplace') return { kind: 'marketplace', to: '/$workspaceId/marketplace' }
	const loopMatch = /^marketplace\/([0-9a-f-]{36})$/i.exec(path)
	if (loopMatch?.[1]) return { kind: 'marketplace_loop', loopId: loopMatch[1] }
	return null
}
