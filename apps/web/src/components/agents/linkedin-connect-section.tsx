import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConnectLinkedin, useLinkedinAccount } from '@/hooks/use-linkedin-account'

interface LinkedinConnectSectionProps {
	agentId: string
	workspaceId: string
}

/**
 * Minimal LinkedIn connect entry point on the agent detail page. Renders one
 * of three states: not-connected (Connect button), in-flight (Spinner while
 * Unipile redirect fires), or connected (sending-as identity + syncing
 * label). T4 replaces this with the full Channels row + state UI + account
 * panel; keep this component small so it's a clean drop-in.
 */
export function LinkedinConnectSection({ agentId, workspaceId }: LinkedinConnectSectionProps) {
	const { data: account, isLoading } = useLinkedinAccount(workspaceId)
	const connect = useConnectLinkedin(workspaceId)

	if (isLoading) {
		return (
			<div className="mb-6">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
					LinkedIn
				</h3>
				<Spinner />
			</div>
		)
	}

	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				LinkedIn
			</h3>
			{account && account.state !== 'handoff' ? (
				<div className="text-sm text-muted-foreground">
					Connected as{' '}
					<span className="text-foreground font-medium">
						{account.sendingAsName ?? 'LinkedIn account'}
					</span>{' '}
					— {account.state.replace('_', ' ')}
				</div>
			) : (
				<div className="flex items-center gap-3">
					<Button
						type="button"
						size="sm"
						onClick={() => connect.mutate({ agentId })}
						disabled={connect.isPending}
					>
						{connect.isPending ? 'Opening…' : 'Connect LinkedIn'}
					</Button>
					<span className="text-xs text-muted-foreground">
						Opens Unipile hosted auth in this tab
					</span>
				</div>
			)}
		</div>
	)
}
