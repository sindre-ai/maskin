import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useReceiptIntake, useReceiptIntakeActions } from '@/hooks/use-receipt-intake'
import type { ReceiptIntakeStatus } from '@/lib/api'
import { useEffect, useState } from 'react'

/**
 * The ways an owner can hand receipts to an Accounting flow besides uploading in chat: a
 * receiving email address and a command. Shows which are on, lets the owner switch the address
 * off or replace it, and make or revoke command keys. Read once by the flow page behind the
 * receipt-intake flag. A flow that is not an Accounting flow answers 404 and this renders nothing.
 */
export function ReceiptRoutesPanel({
	workspaceId,
	loopId,
}: {
	workspaceId: string
	loopId: string
}) {
	const { data } = useReceiptIntake(workspaceId, loopId, true)
	if (!data) return null
	return <Panel workspaceId={workspaceId} loopId={loopId} status={data} />
}

function Panel({
	workspaceId,
	loopId,
	status,
}: {
	workspaceId: string
	loopId: string
	status: ReceiptIntakeStatus
}) {
	const { updateEmail, createKey, revokeKey } = useReceiptIntakeActions(workspaceId, loopId)
	const { email, command, limits } = status
	const [senders, setSenders] = useState(email.allowed_senders.join('\n'))
	const [newKey, setNewKey] = useState<string | null>(null)

	useEffect(() => {
		setSenders(email.allowed_senders.join('\n'))
	}, [email.allowed_senders])

	const sendersChanged = senders.trim() !== email.allowed_senders.join('\n').trim()

	return (
		<section
			aria-label="Ways to send receipts"
			className="space-y-4 rounded-xl border border-border bg-card px-4 py-3.5"
		>
			<div>
				<h3 className="font-medium text-[13px]">Ways to send receipts</h3>
				<p className="text-[12.5px] text-muted-foreground">
					Uploading in the chat always works. You can also email a receipt or send one with a
					command. {limits.file_types.join(', ')} only, up to{' '}
					{Math.round(limits.max_file_bytes / 1048576)} MB each, {limits.daily_cap} a day.
				</p>
			</div>

			<div className="space-y-2" data-testid="receipt-email-route">
				<div className="flex items-center justify-between gap-3">
					<div>
						<p className="font-medium text-[12.5px]">Email</p>
						<p className="text-[12px] text-muted-foreground">
							{email.available
								? email.enabled
									? 'On. Mail from anyone not on the list below is held and never read.'
									: 'Off. Switch it on to get an address for this flow.'
								: 'Not available yet.'}
						</p>
					</div>
					<Switch
						aria-label="Receive receipts by email"
						checked={email.enabled}
						disabled={!email.available || updateEmail.isPending}
						onCheckedChange={(enabled) => updateEmail.mutate({ enabled })}
					/>
				</div>

				{email.enabled && email.address && (
					<>
						<div className="flex items-center gap-2">
							<code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[12px]">
								{email.address}
							</code>
							<CopyButton text={email.address} label ariaLabel="Copy the receiving address" />
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={updateEmail.isPending}
								onClick={() => updateEmail.mutate({ new_address: true })}
							>
								New address
							</Button>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="receipt-senders" className="text-[12px] text-muted-foreground">
								Who may send. One address per line.
								{email.default_sender
									? ` Empty means only ${email.default_sender}.`
									: ' Empty means only you.'}
							</label>
							<Textarea
								id="receipt-senders"
								rows={3}
								value={senders}
								onChange={(e) => setSenders(e.target.value)}
								placeholder={email.default_sender ?? ''}
							/>
							<div className="flex items-center justify-between">
								<p className="text-[12px] text-muted-foreground">
									{email.accepted} taken in, {email.held} held back
								</p>
								<Button
									type="button"
									size="sm"
									variant="secondary"
									disabled={!sendersChanged || updateEmail.isPending}
									onClick={() =>
										updateEmail.mutate({
											allowed_senders: senders
												.split(/[\n,;]+/)
												.map((s) => s.trim())
												.filter(Boolean),
										})
									}
								>
									Save list
								</Button>
							</div>
						</div>
					</>
				)}
			</div>

			<div className="space-y-2" data-testid="receipt-command-route">
				<div className="flex items-center justify-between gap-3">
					<div>
						<p className="font-medium text-[12.5px]">Command</p>
						<p className="text-[12px] text-muted-foreground">
							A key that can only add receipts to this flow. It cannot read or change anything else.
						</p>
					</div>
					<Button
						type="button"
						size="sm"
						variant="secondary"
						disabled={createKey.isPending}
						onClick={() => createKey.mutate(undefined, { onSuccess: (k) => setNewKey(k.key) })}
					>
						Make a key
					</Button>
				</div>

				{newKey && (
					<div className="space-y-1.5 rounded-md border border-border p-2.5">
						<p className="text-[12px]">Copy this now. It is shown once.</p>
						<div className="flex items-center gap-2">
							<code className="min-w-0 flex-1 break-all text-[11.5px]">
								{`curl -X POST ${command.upload_url} -H "Authorization: Bearer ${newKey}" -F file=@receipt.pdf`}
							</code>
							<CopyButton
								text={`curl -X POST ${command.upload_url} -H "Authorization: Bearer ${newKey}" -F file=@receipt.pdf`}
								label
								ariaLabel="Copy the command"
							/>
						</div>
					</div>
				)}

				{command.keys.length > 0 ? (
					<ul className="divide-y divide-border text-[12px]">
						{command.keys.map((k) => (
							<li key={k.id} className="flex items-center justify-between gap-3 py-1.5">
								<span>
									rck_…{k.last4}
									<span className="text-muted-foreground">
										{' '}
										{k.last_used_at
											? `last used ${new Date(k.last_used_at).toLocaleDateString()}`
											: 'not used yet'}
									</span>
								</span>
								<Button
									type="button"
									size="xs"
									variant="ghost"
									disabled={revokeKey.isPending}
									onClick={() => revokeKey.mutate(k.id)}
								>
									Revoke
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-[12px] text-muted-foreground">No keys yet.</p>
				)}
			</div>
		</section>
	)
}
