import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import type { PendingInviteListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatInviteExpiry, inviteRoleLabel } from '@/lib/invite-format'
import { PILL_BUTTON } from '@/lib/pill-button'
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
	const canWrite = useCanWrite()
	const expiry = formatInviteExpiry(invite.expiresAt)
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-3 transition-colors hover:bg-secondary/60">
			<div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
				<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
					<Mail size={14} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[15px] font-semibold">{invite.email}</span>
					<span className="block truncate text-[13px] text-muted-foreground">
						Pending · invited <RelativeTime date={invite.createdAt} />
						{expiry ? ` · ${expiry}` : ''}
					</span>
				</span>
			</div>
			<span className="shrink-0 text-[13.5px] font-semibold text-muted-foreground">
				{inviteRoleLabel(invite.role)}
			</span>
			<div className="ml-auto flex shrink-0 items-center gap-1">
				<ViewerTooltip>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={PILL_BUTTON}
						disabled={resending || !canWrite}
						onClick={() => onResend(invite)}
						aria-label={`Resend invite to ${invite.email}`}
					>
						Resend
					</Button>
				</ViewerTooltip>
				<ViewerTooltip>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(PILL_BUTTON, 'text-error hover:text-error')}
						disabled={!canWrite}
						onClick={() => onRevoke(invite)}
						aria-label={`Revoke invite to ${invite.email}`}
					>
						Revoke
					</Button>
				</ViewerTooltip>
			</div>
		</div>
	)
}
