import { keychainEnvNames } from '@/components/chat/keychain-request-card'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { useSendMessage } from '@/hooks/use-conversation'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useIntegrations } from '@/hooks/use-integrations'
import { ApiError, type MessageKeychainAccessRequest, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useState } from 'react'

interface KeychainAccessRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The agent that asked: the one an Allow gives the credential to. */
	askingAgentId: string
	request: MessageKeychainAccessRequest
}

/**
 * The card an agent puts in chat via `request_keychain_access` to use a credential that
 * is already in the Keychain. It names the credential and holds no secret. Allow grants
 * the agent access on the server, stops its idle session and posts a short message, which
 * starts a fresh session with the credential in its environment. Not now only tells the
 * agent, so it does not wait.
 *
 * Whether it was allowed is read from the integration list, so a card scrolled back to
 * says so instead of offering the buttons again.
 */
export function KeychainAccessRequestCard({
	workspaceId,
	conversationId,
	askingAgentId,
	request,
}: KeychainAccessRequestCardProps) {
	const queryClient = useQueryClient()
	const { workspace } = useWorkspace()
	const { data: integrations } = useIntegrations(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	const settingsUi = useFeatureFlag('keychain-settings-ui')

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [declined, setDeclined] = useState(false)
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	const [allowedNow, setAllowedNow] = useState(false)

	const credential = (integrations ?? []).find((i) => i.id === request.integration_id)
	const allowed = allowedNow || !!credential?.agentGrants?.some((g) => g.actorId === askingAgentId)
	const gone = integrations !== undefined && !credential

	const me = getStoredActor()
	// Same rule as the access editor: whoever saved it, or a workspace admin or owner.
	const canAllow =
		me?.type === 'human' &&
		(credential?.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')

	const allow = async () => {
		setBusy(true)
		setError(null)
		try {
			const res = await api.integrations.allowFromChat(
				request.integration_id,
				workspaceId,
				request.session_id,
			)
			setAllowedNow(true)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still lacks the credential.
				setAgentStillRunning(true)
				return
			}
			const vars = keychainEnvNames(request.kind, request.credential_name)
			const where = vars.length > 0 ? `. It's in your environment as ${vars.join(' and ')}` : ''
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `I've allowed you to use ${request.credential_name} from the Keychain${where}. Please carry on.`,
			})
		} catch (err) {
			setError(
				err instanceof ApiError ? `Couldn't allow: ${err.message}` : "Couldn't allow. Try again.",
			)
		} finally {
			setBusy(false)
		}
	}

	const decline = () => {
		setDeclined(true)
		sendMessage.mutate({
			content: `Not now: please don't use ${request.credential_name}. Carry on without it, or tell me what you need instead.`,
		})
	}

	if (allowed || declined || gone) {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Lock className="size-4 text-muted-foreground" aria-hidden />
				<span>
					{allowed ? (
						<>
							Allowed <strong>{request.credential_name}</strong> for this agent.
						</>
					) : declined ? (
						<>
							Declined <strong>{request.credential_name}</strong>.
						</>
					) : (
						<>
							<strong>{request.credential_name}</strong> is no longer in the Keychain.
						</>
					)}
				</span>
				{allowed && settingsUi ? (
					<Link
						to="/$workspaceId/settings/keychain"
						params={{ workspaceId }}
						className="text-xs text-muted-foreground underline"
					>
						Manage in Keychain
					</Link>
				) : null}
				{agentStillRunning ? (
					<p className="w-full text-xs text-muted-foreground">
						The agent is still running without it. Stop it from the chat, then send a message to
						start it again with the credential.
					</p>
				) : null}
			</div>
		)
	}

	return (
		<div
			role="group"
			aria-label={`Allow ${request.credential_name}`}
			className="mt-2 flex flex-col gap-3 rounded-xl border border-brand/40 bg-brand-subtle p-4"
		>
			<div className="flex items-start gap-2">
				<Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div>
					<h3 className="text-sm font-semibold">Let this agent use {request.credential_name}?</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{request.hint ? `${request.hint} ` : ''}It stays in your encrypted vault and the agent
						never sees the value in the chat. You can take access away in Settings → Keychain.
					</p>
				</div>
			</div>
			{!canAllow ? (
				<p className="text-xs text-muted-foreground">
					Only the person who saved this or a workspace admin can allow it.
				</p>
			) : null}
			<FormError error={error ?? undefined} />
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" disabled={busy || !canAllow} onClick={() => void allow()}>
					Allow
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={busy} onClick={decline}>
					Not now
				</Button>
			</div>
		</div>
	)
}
