import { keychainEnvNames } from '@/components/chat/keychain-request-card'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { useCardAnswer, useSendMessage } from '@/hooks/use-conversation'
import { useIntegrations } from '@/hooks/use-integrations'
import { useContinueSession, useSendSessionInput } from '@/hooks/use-sessions'
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
	/** The message this card is drawn in. */
	messageId: number
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
	messageId,
	askingAgentId,
	request,
}: KeychainAccessRequestCardProps) {
	const queryClient = useQueryClient()
	const { workspace } = useWorkspace()
	const { data: integrations } = useIntegrations(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A helper another agent started is not in this chat: it is answered through its own
	// session, and has no chat of its own to scope an Allow to.
	const helper = request.reply_to_session === true
	const continueSession = useContinueSession(workspaceId, conversationId)
	const sendInput = useSendSessionInput(workspaceId)

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [declinedNow, setDeclinedNow] = useState(false)
	const storedAnswer = useCardAnswer(conversationId, workspaceId, messageId)
	const declined = declinedNow || storedAnswer === 'declined'
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	const [allowedNow, setAllowedNow] = useState<'chat' | 'always' | null>(null)

	const credential = (integrations ?? []).find((i) => i.id === request.integration_id)
	const alwaysAllowed = !!credential?.agentGrants?.some(
		(g) => g.actorId === askingAgentId && g.access !== 'none',
	)
	const chatAllowed = !!credential?.chatGrants?.some(
		(g) => g.actorId === askingAgentId && g.conversationId === conversationId,
	)
	const allowed = allowedNow !== null || alwaysAllowed || chatAllowed
	// Read from the grants once the card has been seen before, so a reload says the same.
	const allowedScope: 'chat' | 'always' | null = alwaysAllowed
		? 'always'
		: chatAllowed
			? 'chat'
			: allowedNow
	const gone = integrations !== undefined && !credential

	const me = getStoredActor()
	// Same rule as the access editor: whoever saved it, or a workspace admin or owner.
	const canAllow =
		me?.type === 'human' &&
		(credential?.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')

	const allow = async (scope: 'chat' | 'always') => {
		setBusy(true)
		setError(null)
		try {
			const res = await api.integrations.allowFromChat(
				request.integration_id,
				workspaceId,
				request.session_id,
				scope,
			)
			setAllowedNow(scope)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still lacks the credential.
				setAgentStillRunning(true)
				return
			}
			const vars = keychainEnvNames(request.kind, request.credential_name)
			const where = vars.length > 0 ? `. It's in your environment as ${vars.join(' and ')}` : ''
			if (helper) {
				continueSession.mutate({
					id: request.session_id,
					content: `I've allowed you to use ${request.credential_name} from the Keychain${where}. Carry on with the work.`,
				})
				return
			}
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `I've allowed you to use ${request.credential_name} from the Keychain${scope === 'chat' ? ' in this chat only' : ''}${where}. Reply with one short line to say you have it, then carry on.`,
				metadata: { hidden_from_chat: true },
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
		setDeclinedNow(true)
		if (helper) {
			sendInput.mutate({
				id: request.session_id,
				content: `Not now: please don't use ${request.credential_name}. Carry on without it, or tell me what you need instead.`,
				card_answer: { message_id: messageId, outcome: 'declined' },
				conversationId,
			})
			return
		}
		sendMessage.mutate({
			content: `Not now: please don't use ${request.credential_name}. Carry on without it, or tell me what you need instead.`,
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: messageId, outcome: 'declined' },
			},
		})
	}

	if (allowed || declined || gone) {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Lock className="size-4 text-muted-foreground" aria-hidden />
				<span>
					{allowed ? (
						<>
							Allowed <strong>{request.credential_name}</strong>{' '}
							{allowedScope === 'chat'
								? 'for this agent in this chat only.'
								: 'for this agent. It stays until you remove it.'}
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
				{allowed ? (
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
		<fieldset
			aria-label={`Allow ${request.credential_name}`}
			className="mt-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
		>
			<div className="flex items-start gap-2">
				<Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div>
					<h3 className="text-sm font-semibold">Let this agent use {request.credential_name}?</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{request.hint ? `${request.hint} ` : ''}It stays in your encrypted vault and the agent
						never sees the value in the chat. Choose how long it can use it:
					</p>
				</div>
			</div>
			{!canAllow ? (
				<p className="text-xs text-muted-foreground">
					Only the person who saved this or a workspace admin can allow it.
				</p>
			) : null}
			<FormError error={error ?? undefined} />
			<ul className="list-disc space-y-0.5 pl-8 text-xs text-muted-foreground">
				{helper ? null : (
					<li>
						<strong className="font-medium text-foreground">Allow in this chat</strong>: only this
						agent, only in this conversation.
					</li>
				)}
				<li>
					<strong className="font-medium text-foreground">Always allow</strong>: this agent, in any
					chat or run, until you remove it in Settings → Keychain.
				</li>
			</ul>
			<div className="flex flex-wrap items-center gap-2">
				{helper ? null : (
					<Button
						type="button"
						size="sm"
						disabled={busy || !canAllow}
						onClick={() => void allow('chat')}
					>
						Allow in this chat
					</Button>
				)}
				<Button
					type="button"
					size="sm"
					variant={helper ? 'default' : 'outline'}
					disabled={busy || !canAllow}
					onClick={() => void allow('always')}
				>
					Always allow
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={busy} onClick={decline}>
					Not now
				</Button>
			</div>
		</fieldset>
	)
}
