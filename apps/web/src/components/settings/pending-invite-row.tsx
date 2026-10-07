import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import type { PendingInviteListItem } from '@/lib/api'
import { formatInviteExpiry, inviteRoleLabel } from '@/lib/invite-format'
import { Mail } from 'lucide-react'

export function PendingInviteRow({
	invite,
	onResend,
	onRevoke,
	resending,
}: {
	invite: PendingInviteListItem
	onResend: (invite: PendingInviteListItem) => void
	onRevoke: (invite: PendingInviteListItem) => void
	resending: boolean
}) {
	const expiry = formatInviteExpiry(invite.expiresAt)
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-b border-border px-2 py-2.5 transition-colors hover:bg-muted">
			<div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
				<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
					<Mail size={14} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{invite.email}</span>
					<span className="block truncate text-xs text-muted-foreground">
						Pending · invited <RelativeTime date={invite.createdAt} />
						{expiry ? ` · ${expiry}` : ''}
					</span>
				</span>
			</div>
			<span className="w-14 shrink-0 text-xs text-muted-foreground">
				{inviteRoleLabel(invite.role)}
			</span>
			<div className="ml-auto flex shrink-0 items-center gap-1">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={resending}
					onClick={() => onResend(invite)}
					aria-label={`Resend invite to ${invite.email}`}
				>
					Resend
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-error hover:text-error"
					onClick={() => onRevoke(invite)}
					aria-label={`Revoke invite to ${invite.email}`}
				>
					Revoke
				</Button>
			</div>
		</div>
	)
}
