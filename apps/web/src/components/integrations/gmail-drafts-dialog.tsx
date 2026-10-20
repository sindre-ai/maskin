import { EmptyState } from '@/components/shared/empty-state'
import { FormError } from '@/components/shared/form-error'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useGmailDrafts, useSendGmailDraft } from '@/hooks/use-integrations'
import { ApiError, type GmailDraft } from '@/lib/api'
import { useState } from 'react'

/**
 * Review and send the drafts agents leave in Gmail. Agents can only create drafts
 * (Google's Gmail tool has no send); this is where a person reads one and sends
 * it. Sending cannot be undone, so it takes two clicks, and the server refuses to
 * send a draft that was edited after it was shown here.
 */
export function GmailDraftsDialog({
	workspaceId,
	open,
	onClose,
}: {
	workspaceId: string
	open: boolean
	onClose: () => void
}) {
	const { data, isLoading, error } = useGmailDrafts(workspaceId, open)
	const send = useSendGmailDraft(workspaceId)
	// The version the person asked to send. If the list refetches and that draft's
	// version moved, the confirm no longer applies and falls away on its own.
	const [confirming, setConfirming] = useState<{ draftId: string; messageId: string } | null>(null)
	const drafts = data?.drafts ?? []

	return (
		<ResponsiveDialog open={open} onOpenChange={(next) => !next && onClose()}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Gmail drafts</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Drafts your agents wrote in Gmail. Nothing is sent until you send it here.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				{isLoading ? (
					<ListSkeleton rows={3} />
				) : error ? (
					<FormError
						error={error instanceof ApiError ? error.message : "Couldn't load your drafts"}
					/>
				) : drafts.length === 0 ? (
					<EmptyState
						title="No drafts"
						description="When an agent drafts an email, it shows up here to review."
						className="py-8"
					/>
				) : (
					<ul className="max-h-[60dvh] space-y-2 overflow-y-auto">
						{drafts.map((draft) => (
							<DraftRow
								key={draft.draft_id}
								draft={draft}
								confirming={
									confirming?.draftId === draft.draft_id &&
									confirming.messageId === draft.message_id
								}
								sending={send.isPending && send.variables?.draftId === draft.draft_id}
								error={
									send.isError && send.variables?.draftId === draft.draft_id ? send.error : null
								}
								onAsk={() => {
									send.reset()
									setConfirming({ draftId: draft.draft_id, messageId: draft.message_id })
								}}
								onCancel={() => setConfirming(null)}
								onConfirm={() =>
									send.mutate(
										{ draftId: draft.draft_id, messageId: draft.message_id },
										{ onSettled: () => setConfirming(null) },
									)
								}
							/>
						))}
					</ul>
				)}
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function DraftRow({
	draft,
	confirming,
	sending,
	error,
	onAsk,
	onCancel,
	onConfirm,
}: {
	draft: GmailDraft
	confirming: boolean
	sending: boolean
	error: Error | null
	onAsk: () => void
	onCancel: () => void
	onConfirm: () => void
}) {
	const recipients = [draft.to, draft.cc].filter(Boolean).join(', ')
	return (
		<li className="rounded-md border border-border bg-bg-surface p-3">
			<div className="flex flex-wrap items-start gap-3">
				<div className="min-w-0 flex-1 basis-48">
					<p className="truncate text-sm font-medium text-foreground">
						{draft.subject || '(no subject)'}
					</p>
					<p className="truncate text-xs text-muted-foreground">
						{recipients ? `To ${recipients}` : 'No recipient yet'}
					</p>
					{draft.snippet && (
						<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{draft.snippet}</p>
					)}
				</div>
				{!confirming && (
					<Button size="sm" className="shrink-0" onClick={onAsk} disabled={!draft.to}>
						Send
					</Button>
				)}
			</div>
			{confirming && (
				<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
					<p className="min-w-0 flex-1 basis-48 text-xs text-foreground">
						Send this to {draft.to}? This can't be undone.
					</p>
					<Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
						Cancel
					</Button>
					<Button size="sm" onClick={onConfirm} disabled={sending}>
						{sending ? 'Sending…' : 'Send email'}
					</Button>
				</div>
			)}
			<FormError error={error?.message} />
		</li>
	)
}
