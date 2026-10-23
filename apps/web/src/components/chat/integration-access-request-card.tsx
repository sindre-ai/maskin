import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
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

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [declinedNow, setDeclinedNow] = useState(false)
	const [allowedNow, setAllowedNow] = useState(false)
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	const storedAnswer = useCardAnswer(conversationId, workspaceId, messageId)
	const declined = declinedNow || storedAnswer === 'declined'

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

	const allow = async () => {
		setBusy(true)
		setError(null)
		try {
			const res = await api.integrations.allowAccess(
				request.integration_id,
				workspaceId,
				request.session_id,
				request.level,
			)
			setAllowedNow(true)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.changed && res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still has the old access.
				setAgentStillRunning(true)
				return
			}
			const content = res.changed
				? `I've allowed you ${levelText(request.level)} to ${request.display_name}. Carry on with the work.`
				: `You already have ${levelText(request.level)} to ${request.display_name}. Carry on with the work.`
			if (helper) {
				// Stopped to take the new access, so its follow-up carries on; not stopped, so write into it.
				if (res.changed) continueSession.mutate({ id: request.session_id, content })
				else sendInput.mutate({ id: request.session_id, content, conversationId })
				return
			}
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `${content} Reply with one short line to say you have it.`,
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

	if (allowed || declined || gone) {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<KeyRound className="size-4 text-muted-foreground" aria-hidden />
				<span>
					{allowed ? (
						<>
							Allowed <strong>{request.display_name}</strong> for this agent. It stays until you
							remove it.
						</>
					) : declined ? (
						<>
							Declined <strong>{request.display_name}</strong>.
						</>
					) : (
						<>
							<strong>{request.display_name}</strong> is no longer connected.
						</>
					)}
				</span>
				{allowed ? (
					<Link
						to="/$workspaceId/settings/integrations"
						params={{ workspaceId }}
						className="text-xs text-muted-foreground underline"
					>
						Manage in Integrations
					</Link>
				) : null}
				{agentStillRunning ? (
					<p className="w-full text-xs text-muted-foreground">
						The agent is still running with its old access. Stop it from the chat, then send a
						message to start it again.
					</p>
				) : null}
			</div>
		)
	}

	return (
		<fieldset
			aria-label={`Allow ${request.display_name}`}
			className="mt-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
		>
			<div className="flex items-start gap-2">
				<KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div>
					<h3 className="text-sm font-semibold">
						Let this agent have {levelText(request.level)} to {request.display_name}?
					</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{request.reason ? `${request.reason} ` : ''}
						{request.level === 'read_write'
							? 'It can look things up and make changes there, in any chat or run, until you remove it in Settings → Integrations.'
							: 'It can look things up there, in any chat or run, until you remove it in Settings → Integrations.'}
					</p>
				</div>
			</div>
			{!canAllow ? (
				<p className="text-xs text-muted-foreground">
					Only the person who connected this or a workspace admin can allow it.
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
		</fieldset>
	)
}
