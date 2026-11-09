import { REQUEST_CARD, REQUEST_CARD_BUTTON } from '@/components/chat/request-card-styles'
import { Button } from '@/components/ui/button'
import { useConversation } from '@/hooks/use-conversation'
import { cn } from '@/lib/cn'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'

/**
 * The pieces every request card in chat is built from (keychain, tool server, integration
 * access, keychain access): the icon + title header, the labelled field row, and the one-line
 * folded answer with its path back. Classes for the card shell and its buttons live in
 * `request-card-styles.ts`.
 */

/** Bold title and, under it, the reason in green. The icon is no longer drawn (v3). */
export function RequestCardHeader({
	title,
	children,
}: {
	icon?: LucideIcon
	title: ReactNode
	children?: ReactNode
}) {
	return (
		<div className="min-w-0">
			<h3 className="mb-1 text-[15px] font-bold leading-tight">{title}</h3>
			{children ? (
				<p className="mt-2 break-words text-[12.5px] font-semibold text-success">{children}</p>
			) : null}
		</div>
	)
}

/** A labelled value on a tinted row, with an optional action at the end ("Change"). */
export function RequestCardRow({
	label,
	children,
	action,
}: {
	label: string
	children: ReactNode
	action?: ReactNode
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-muted px-2.5 py-[7px] text-[12.5px]">
			<span className="w-[4.5rem] shrink-0 text-[12.5px] font-semibold text-muted-foreground">
				{label}
			</span>
			{/* The basis wraps the value under its label in a narrow thread pane. */}
			<span className="min-w-0 flex-1 basis-32 break-words">{children}</span>
			{action}
		</div>
	)
}

/** A text-style action inside a card or a folded answer: "Change", "Undo", "Manage". */
export const REQUEST_CARD_LINK =
	'shrink-0 font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground max-md:inline-flex max-md:min-h-11 max-md:items-center'

/**
 * The folded state of a card: one soft line that says what happened, with the way back on the
 * right. Also the viewer / non-admin state, where `actions` holds an action instead of a
 * disabled button.
 */
export function RequestCardSummary({
	icon: Icon,
	children,
	actions,
	note,
	className,
}: {
	icon: LucideIcon
	children: ReactNode
	actions?: ReactNode
	/** A second line under the summary, e.g. "the agent is still running". */
	note?: ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'mt-2 flex flex-wrap items-center gap-x-2.5 rounded-xl bg-secondary px-3.5 py-2.5 text-[13px] max-md:min-h-11',
				className,
			)}
		>
			<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			<span className="min-w-0 flex-1 break-words">{children}</span>
			{actions ? <span className="flex shrink-0 items-center gap-2 text-xs">{actions}</span> : null}
			{note ? <p className="w-full pt-1 text-xs text-muted-foreground">{note}</p> : null}
		</div>
	)
}

/**
 * What a viewer, or someone who is not allowed to answer, sees instead of a form with disabled
 * buttons: who may do it, and one action that helps. "Ask an admin" copies the link to the chat
 * so it can be sent to someone who can.
 */
export function RequestCardReadOnly({
	icon,
	title,
	children,
}: {
	icon: LucideIcon
	title: string
	children: ReactNode
}) {
	return (
		<section aria-label={title} className={REQUEST_CARD}>
			<RequestCardHeader icon={icon} title={title}>
				{children}
			</RequestCardHeader>
			<div>
				<Button
					type="button"
					variant="outline"
					className={cn(REQUEST_CARD_BUTTON, 'bg-background')}
					onClick={() => {
						void navigator.clipboard?.writeText(window.location.href).then(
							() => toast.success('Link copied. Send it to someone who can answer.'),
							() => toast.error("Couldn't copy the link"),
						)
					}}
				>
					Ask an admin
				</Button>
			</div>
		</section>
	)
}

/** "this agent" at the start of a sentence. */
export const capFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** The name of the agent that asked, read from the chat; `fallback` when it is not in it. */
export function useAskingAgentName(
	conversationId: string,
	workspaceId: string,
	askingAgentId: string,
	fallback = 'this agent',
): string {
	const { data } = useConversation(conversationId, workspaceId)
	return data?.participants?.find((p) => p.actorId === askingAgentId)?.actorName ?? fallback
}
