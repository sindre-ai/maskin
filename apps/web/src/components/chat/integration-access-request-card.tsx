import {
	REQUEST_CARD_LINK,
	RequestCardHeader,
	RequestCardReadOnly,
	RequestCardRow,
	RequestCardSummary,
	capFirst,
	useAskingAgentName,
} from '@/components/chat/request-card-parts'
import {
	REQUEST_CARD,
	REQUEST_CARD_ACTIONS,
	REQUEST_CARD_DECLINE,
	REQUEST_CARD_PRIMARY,
} from '@/components/chat/request-card-styles'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useCanWrite } from '@/hooks/use-can-write'
import { useCardAnswer, useSendMessage } from '@/hooks/use-conversation'
import { useIntegrations } from '@/hooks/use-integrations'
import { useContinueSession, useSendSessionInput } from '@/hooks/use-sessions'
import { ApiError, type MessageIntegrationAccessRequest, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'

interface IntegrationAccessRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The message this card is drawn in. */
	messageId: number
	/** The agent that asked: the one an Allow gives the access to. */
	askingAgentId: string
	request: MessageIntegrationAccessRequest
}

const RANK = { none: 0, read: 1, read_write: 2 } as const

const levelText = (level: MessageIntegrationAccessRequest['level']) =>
	level === 'read_write' ? 'read and write access' : 'read access'

/**
 * The card an agent puts in chat via `request_integration_access` for an integration that is
 * connected but not allowed for it. It names the integration and the level and holds nothing
 * else. Allow sets the agent's access on the server, the same as Settings → Integrations,
 * stops its idle session and posts a short message, which starts a fresh session that knows
 * its new access. Not now only tells the agent, so it does not wait.
 *
 * Whether it was allowed is read from the integration list, so a card scrolled back to says
 * so instead of offering the buttons again.
 */
export function IntegrationAccessRequestCard({
	workspaceId,
	conversationId,
	messageId,
	askingAgentId,
	request,
}: IntegrationAccessRequestCardProps) {
	const queryClient = useQueryClient()
	const { workspace } = useWorkspace()
	const { data: integrations } = useIntegrations(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A helper another agent started is not in this chat: it is answered through its own session.
	const helper = request.reply_to_session === true
	const continueSession = useContinueSession(workspaceId, conversationId)
	const sendInput = useSendSessionInput(workspaceId)
	// Allowing access and declining both answer the agent, which a viewer cannot do.
	const canWrite = useCanWrite()
	const agentName = useAskingAgentName(conversationId, workspaceId, askingAgentId)

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [declinedNow, setDeclinedNow] = useState(false)
	const [allowedNow, setAllowedNow] = useState(false)
	const [chatAllowedNow, setChatAllowedNow] = useState(false)
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	// The level can be lowered before Allow, never raised above what the agent asked for.
	const [chosen, setChosen] = useState<'read' | 'read_write'>(request.level)
	const storedAnswer = useCardAnswer(conversationId, workspaceId, messageId)
	const declined = declinedNow || storedAnswer === 'declined'
	// Offered by the server for a write ask on Calendar or Meet. Only the full level can be lifted.
	const lift = request.level === 'read_write' ? (request.chat_lift ?? null) : null
	const chatAllowed = lift !== null && (chatAllowedNow || storedAnswer === 'done')

	const integration = (integrations ?? []).find((i) => i.id === request.integration_id)
	// An agent's own entry wins over the default for agents without one.
	const own = integration?.agentGrants?.find((g) => g.actorId === askingAgentId)?.access
	const current = own ?? integration?.defaultAgentAccess ?? 'none'
	const allowed = allowedNow || RANK[current] >= RANK[request.level]
	const gone = integrations !== undefined && (!integration || integration.status !== 'active')

	const me = getStoredActor()
	// Same rule as the access editor: whoever connected it, or a workspace admin or owner.
	const canAllow =
		me?.type === 'human' &&
		(integration?.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')

	const allow = async (scope: 'always' | 'chat' = 'always') => {
		setBusy(true)
		setError(null)
		try {
			const res =
				scope === 'chat'
					? await api.integrations.allowAccess(
							request.integration_id,
							workspaceId,
							request.session_id,
							'read_write',
							'chat',
						)
					: await api.integrations.allowAccess(
							request.integration_id,
							workspaceId,
							request.session_id,
							chosen,
						)
			if (scope === 'chat') setChatAllowedNow(true)
			else setAllowedNow(true)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.changed && res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still has the old access.
				setAgentStillRunning(true)
				return
			}
			const content =
				scope === 'chat'
					? `I've allowed you read and write access to ${request.display_name} for the next ${lift?.hours ?? 8} hours, in this chat only. Carry on with the work.`
					: res.changed
						? `I've allowed you ${levelText(chosen)} to ${request.display_name}. Carry on with the work.`
						: `You already have ${levelText(chosen)} to ${request.display_name}. Carry on with the work.`
			if (helper) {
				// Stopped to take the new access, so its follow-up carries on; not stopped, so write into it.
				if (res.changed) continueSession.mutate({ id: request.session_id, content })
				else sendInput.mutate({ id: request.session_id, content, conversationId })
				return
			}
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `${content} Reply with one short line to say you have it.`,
				metadata: {
					hidden_from_chat: true,
					// A chat Allow leaves the standing level as it was, so the card reads the answer from here.
					...(scope === 'chat' ? { card_answer: { message_id: messageId, outcome: 'done' } } : {}),
				},
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
		const content = `Not now: please don't use ${request.display_name} yet. Carry on without it, or tell me what you need instead.`
		if (helper) {
			sendInput.mutate({
				id: request.session_id,
				content,
				card_answer: { message_id: messageId, outcome: 'declined' },
				conversationId,
			})
			return
		}
		sendMessage.mutate({
			content,
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: messageId, outcome: 'declined' },
			},
		})
	}

	// Asking again is a plain message the agent answers with a new card.
	const askAgain = () => {
		setDeclinedNow(false)
		const content = `Please ask me for ${request.display_name} access again.`
		if (helper) {
			sendInput.mutate({ id: request.session_id, content, conversationId })
			return
		}
		sendMessage.mutate({ content })
	}

	if (allowed || chatAllowed || declined || gone) {
		return (
			<RequestCardSummary
				icon={KeyRound}
				note={
					agentStillRunning
						? 'The agent is still running with its old access. Stop it from the chat, then send a message to start it again.'
						: null
				}
				actions={
					allowed || chatAllowed ? (
						<Link
							to="/$workspaceId/settings/integrations"
							params={{ workspaceId }}
							search={{ select_github: undefined, error: undefined, return_to: undefined }}
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
						Allowed <strong>{request.display_name}</strong> for {agentName}. It stays until you
						remove it.
					</>
				) : chatAllowed ? (
					<>
						Allowed <strong>{request.display_name}</strong> for {agentName} in this chat for{' '}
						{lift?.hours} hours.
					</>
				) : declined ? (
					<>
						Declined <strong>{request.display_name}</strong> for {agentName}.
					</>
				) : (
					<>
						<strong>{request.display_name}</strong> is no longer connected.
					</>
				)}
			</RequestCardSummary>
		)
	}

	if (!canWrite || !canAllow) {
		return (
			<RequestCardReadOnly icon={KeyRound} title={`Allow ${request.display_name} for ${agentName}`}>
				{canWrite
					? 'Only the person who connected this or a workspace admin can allow it.'
					: 'Only a person with edit access can allow it.'}
			</RequestCardReadOnly>
		)
	}

	return (
		<fieldset aria-label={`Allow ${request.display_name}`} className={REQUEST_CARD}>
			<RequestCardHeader icon={KeyRound} title={`Allow ${request.display_name} for ${agentName}`}>
				{lift
					? lift.text
					: request.reason
						? `${request.reason}`
						: `${capFirst(agentName)} needs it to carry on.`}
			</RequestCardHeader>
			<RequestCardRow label="Integration">{request.display_name}</RequestCardRow>
			{lift?.tool ? <RequestCardRow label="Tool asked for">{lift.tool}</RequestCardRow> : null}
			{lift && request.reason ? (
				<RequestCardRow label="The agent says">{request.reason}</RequestCardRow>
			) : null}
			<RequestCardRow label="Access">
				{request.level === 'read_write' ? (
					<RadioGroup
						value={chosen}
						onValueChange={(v) => setChosen(v === 'read' ? 'read' : 'read_write')}
						aria-label="Access level"
						className="flex flex-wrap gap-x-4 gap-y-1"
					>
						<div className="flex items-center gap-2 max-md:min-h-11">
							<RadioGroupItem value="read" id={`ia-read-${messageId}`} />
							<Label htmlFor={`ia-read-${messageId}`} className="font-normal">
								Read
							</Label>
						</div>
						<div className="flex items-center gap-2 max-md:min-h-11">
							<RadioGroupItem value="read_write" id={`ia-rw-${messageId}`} />
							<Label htmlFor={`ia-rw-${messageId}`} className="font-normal">
								Read and write
							</Label>
						</div>
					</RadioGroup>
				) : (
					'Read'
				)}
			</RequestCardRow>
			<RequestCardRow label="Lasts">
				{lift
					? `Allow in this chat: ${lift.hours} hours. Always allow: until you remove it in Integrations`
					: 'Until you remove it in Integrations'}
			</RequestCardRow>
			<FormError error={error ?? undefined} />
			<div className={REQUEST_CARD_ACTIONS}>
				{lift && chosen === 'read_write' ? (
					<Button
						type="button"
						className={REQUEST_CARD_PRIMARY}
						disabled={busy}
						onClick={() => void allow('chat')}
					>
						Allow in this chat for {lift.hours} hours
					</Button>
				) : null}
				<Button
					type="button"
					variant={lift && chosen === 'read_write' ? 'outline' : undefined}
					className={lift && chosen === 'read_write' ? undefined : REQUEST_CARD_PRIMARY}
					disabled={busy}
					onClick={() => void allow()}
				>
					{lift ? 'Always allow' : 'Allow'}
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
