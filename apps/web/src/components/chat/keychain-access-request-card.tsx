import { keychainUseHint } from '@/components/chat/keychain-request-card'
import {
	REQUEST_CARD_LINK,
	RequestCardHeader,
	RequestCardReadOnly,
	RequestCardSummary,
} from '@/components/chat/request-card-parts'
import {
	REQUEST_CARD,
	REQUEST_CARD_ACTIONS,
	REQUEST_CARD_DECLINE,
	REQUEST_CARD_PRIMARY,
} from '@/components/chat/request-card-styles'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
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
 * starts a fresh session with the credential (an API key in its environment; a login to
 * type with desktop_type, never to read). Not now only tells the
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
	// Allowing access and declining both answer the agent, which a viewer cannot do.
	const canWrite = useCanWrite()

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
			const where = keychainUseHint(request.kind, request.credential_name)
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

	// Asking again is a plain message the agent answers with a new card.
	const askAgain = () => {
		setDeclinedNow(false)
		const content = `Please ask me to use ${request.credential_name} again.`
		if (helper) {
			sendInput.mutate({ id: request.session_id, content, conversationId })
			return
		}
		sendMessage.mutate({ content })
	}

	if (allowed || declined || gone) {
		return (
			<RequestCardSummary
				icon={Lock}
				note={
					agentStillRunning
						? 'The agent is still running without it. Stop it from the chat, then send a message to start it again with the credential.'
						: null
				}
				actions={
					allowed ? (
						<Link
							to="/$workspaceId/settings/keychain"
							params={{ workspaceId }}
							className={REQUEST_CARD_LINK}
						>
							Manage
						</Link>
					) : declined && canWrite ? (
						<button type="button" className={REQUEST_CARD_LINK} onClick={askAgain}>
							Ask again
						</button>
					) : null
				}
			>
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
			</RequestCardSummary>
		)
	}

	if (!canWrite || !canAllow) {
		return (
			<RequestCardReadOnly icon={Lock} title={`Use ${request.credential_name}`}>
				{canWrite
					? 'Only the person who saved this or a workspace admin can allow it.'
					: 'Only a person with edit access can allow it.'}
			</RequestCardReadOnly>
		)
	}

	return (
		<fieldset aria-label={`Allow ${request.credential_name}`} className={REQUEST_CARD}>
			<RequestCardHeader icon={Lock} title={`Let this agent use ${request.credential_name}?`}>
				{request.hint ? `${request.hint} ` : ''}It stays in your encrypted vault and the agent never
				sees the value in the chat. Choose how long it can use it:
			</RequestCardHeader>
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
			<div className={REQUEST_CARD_ACTIONS}>
				{helper ? null : (
					<Button
						type="button"
						className={REQUEST_CARD_PRIMARY}
						disabled={busy}
						onClick={() => void allow('chat')}
					>
						Allow in this chat
					</Button>
				)}
				<Button
					type="button"
					className={REQUEST_CARD_PRIMARY}
					variant={helper ? 'default' : 'outline'}
					disabled={busy}
					onClick={() => void allow('always')}
				>
					Always allow
				</Button>
				<Button
					type="button"
					variant="ghost"
					className={REQUEST_CARD_DECLINE}
					disabled={busy}
					onClick={decline}
				>
					Not now
				</Button>
			</div>
		</fieldset>
	)
}
