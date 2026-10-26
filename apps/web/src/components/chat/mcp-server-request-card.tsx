import { SecretInput } from '@/components/keychain/secret-input'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCardAnswer, useSendMessage } from '@/hooks/use-conversation'
import { useIntegrations } from '@/hooks/use-integrations'
import { useContinueSession, useSendSessionInput } from '@/hooks/use-sessions'
import { ApiError, type CustomMcpServerSpec, type MessageMcpServerRequest, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plug } from 'lucide-react'
import { useState } from 'react'

interface McpServerRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The message this card is drawn in. */
	messageId: number
	/** When the message was posted, so a server added since can be matched back to it. */
	messageCreatedAt: string | null
	/** The agent that asked: the one the server is given to. */
	askingAgentId: string
	request: MessageMcpServerRequest
}

/** The server to save: what the agent gave, plus the secrets the person typed in. */
export function buildMcpServer(
	request: MessageMcpServerRequest,
	secrets: { env: Record<string, string>; headers: Record<string, string> },
): CustomMcpServerSpec {
	const env = { ...request.env, ...secrets.env }
	const headers = { ...request.headers, ...secrets.headers }
	return {
		...(request.type ? { type: request.type } : {}),
		...(request.command ? { command: request.command } : {}),
		...(request.args ? { args: request.args } : {}),
		...(request.url ? { url: request.url } : {}),
		...(Object.keys(env).length > 0 ? { env } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	}
}

/**
 * The card an agent puts in chat via `add_mcp_server` for a tool server it already knows how to
 * run or reach. It shows exactly what would be added (the command or address, and any values the
 * agent gave) and an input for each secret the server needs. Add saves the server like Settings →
 * Integrations does, gives it to the agent that asked, stops that agent's idle session and posts a
 * short message, which starts a fresh session that has the server attached. Secrets are typed here
 * and go straight to the server definition: they never pass through the agent or the message.
 *
 * Whether it was added is read from the chat (the person's answer) and the integration list, so a
 * card scrolled back to says so instead of offering the form again.
 */
export function McpServerRequestCard({
	workspaceId,
	conversationId,
	messageId,
	messageCreatedAt,
	askingAgentId,
	request,
}: McpServerRequestCardProps) {
	const queryClient = useQueryClient()
	const { data: integrations } = useIntegrations(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A helper another agent started is not in this chat: it is answered through its own session.
	const helper = request.reply_to_session === true
	const continueSession = useContinueSession(workspaceId, conversationId)
	const sendInput = useSendSessionInput(workspaceId)

	const [name, setName] = useState(request.name)
	const [secretEnv, setSecretEnv] = useState<Record<string, string>>({})
	const [secretHeaders, setSecretHeaders] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [savedId, setSavedId] = useState<string | null>(null)
	const [addedName, setAddedName] = useState<string | null>(null)
	const [declinedNow, setDeclinedNow] = useState(false)
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	const storedAnswer = useCardAnswer(conversationId, workspaceId, messageId)
	const declined = declinedNow || storedAnswer === 'declined'

	const addedEarlier = (integrations ?? []).find(
		(i) =>
			i.provider === 'custom-mcp' &&
			i.status === 'active' &&
			i.displayName === request.name &&
			!!i.createdAt &&
			(!messageCreatedAt || i.createdAt >= messageCreatedAt),
	)
	const givenEarlier = addedEarlier?.agentGrants?.some(
		(g) => g.actorId === askingAgentId && g.access !== 'none',
	)
	// Only "given" counts as done: a server saved whose grant failed offers to give it instead.
	const doneName =
		addedName ??
		(storedAnswer === 'done' ? request.name : null) ??
		(givenEarlier ? addedEarlier?.displayName : null)
	// Saved but not given: only the grant is left, so no secrets are asked for again.
	const savedServerId = savedId ?? (addedEarlier && !givenEarlier ? addedEarlier.id : null)

	const secretEnvNames = request.secret_env ?? []
	const secretHeaderNames = request.secret_headers ?? []
	const filled =
		savedServerId !== null ||
		(secretEnvNames.every((n) => (secretEnv[n] ?? '').length > 0) &&
			secretHeaderNames.every((n) => (secretHeaders[n] ?? '').length > 0))
	const me = getStoredActor()
	const canAdd = me?.type === 'human'
	const canSubmit = !busy && canAdd && name.trim().length > 0 && filled

	const add = async () => {
		if (!canSubmit) return
		setBusy(true)
		setError(null)
		const displayName = name.trim()
		try {
			let id = savedServerId
			if (!id) {
				const created = await api.customMcpServers.create(workspaceId, {
					name: displayName,
					server: buildMcpServer(request, { env: secretEnv, headers: secretHeaders }),
				})
				id = created.id
				setSavedId(id)
				// The values are gone from the page the moment they are saved.
				setSecretEnv({})
				setSecretHeaders({})
			}
			// A server that runs inside the agent cannot be limited to reading, so it is always read & write.
			const res = await api.integrations.allowAccess(
				id,
				workspaceId,
				request.session_id,
				'read_write',
			)
			setAddedName(displayName)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.changed && res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still lacks the server.
				setAgentStillRunning(true)
				return
			}
			const content = `I've added the ${displayName} tool server for you. Carry on with the work.`
			if (helper) {
				if (res.changed) continueSession.mutate({ id: request.session_id, content })
				else sendInput.mutate({ id: request.session_id, content, conversationId })
				return
			}
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `${content} Reply with one short line to say you have it.`,
				metadata: {
					hidden_from_chat: true,
					card_answer: { message_id: messageId, outcome: 'done' },
				},
			})
		} catch (err) {
			setError(
				err instanceof ApiError ? `Couldn't add: ${err.message}` : "Couldn't add. Try again.",
			)
		} finally {
			setBusy(false)
		}
	}

	const decline = () => {
		setDeclinedNow(true)
		const content = `Not now: please don't add the ${request.name} tool server yet. Carry on without it, or tell me what you need instead.`
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

	if (doneName || declined) {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Plug className="size-4 text-muted-foreground" aria-hidden />
				<span>
					{doneName ? (
						<>
							Added <strong>{doneName}</strong> and gave it to this agent.
						</>
					) : (
						<>
							Declined <strong>{request.name}</strong>.
						</>
					)}
				</span>
				{doneName ? (
					<Link
						to="/$workspaceId/settings/integrations"
						params={{ workspaceId }}
						search={{ select_github: undefined, error: undefined, return_to: undefined }}
						className="text-xs text-muted-foreground underline"
					>
						Manage in Integrations
					</Link>
				) : null}
				{agentStillRunning ? (
					<p className="w-full text-xs text-muted-foreground">
						The agent is still running without it. Stop it from the chat, then send a message to
						start it again with the server.
					</p>
				) : null}
			</div>
		)
	}

	const command = [request.command, ...(request.args ?? [])].filter(Boolean).join(' ')
	const secretFields = [
		...secretEnvNames.map((n) => ({ kind: 'env' as const, name: n })),
		...secretHeaderNames.map((n) => ({ kind: 'header' as const, name: n })),
	]
	const givenValues = [
		...Object.entries(request.env ?? {}).map(([key, value]) => ({ key, value })),
		...Object.entries(request.headers ?? {}).map(([key, value]) => ({ key, value })),
	]

	return (
		<form
			className="mt-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
			aria-label={`Add ${request.name}`}
			onSubmit={(e) => {
				e.preventDefault()
				void add()
			}}
		>
			<div className="flex items-start gap-2">
				<Plug className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">Add the {request.name} tool server?</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{request.hint ? `${request.hint} ` : ''}It is saved for this workspace and given to this
						agent only, with read and write access. You can change that in Settings → Integrations.
					</p>
				</div>
			</div>

			<div className="space-y-1">
				{command ? (
					<>
						<p className="text-xs font-medium">Runs this command inside the agent</p>
						<code className="block break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
							{command}
						</code>
					</>
				) : null}
				{request.url ? (
					<>
						<p className="text-xs font-medium">Connects to</p>
						<code className="block break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
							{request.url}
						</code>
					</>
				) : null}
				{givenValues.length > 0 ? (
					<ul className="font-mono text-xs text-muted-foreground">
						{givenValues.map(({ key, value }) => (
							<li key={key} className="break-all">
								{key}={value}
							</li>
						))}
					</ul>
				) : null}
			</div>

			{savedServerId ? (
				<p className="text-xs text-muted-foreground">
					The server is added. Give it to this agent to finish; nothing more to type.
				</p>
			) : (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`mcp-name-${messageId}`}>Name</Label>
						<Input
							id={`mcp-name-${messageId}`}
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={60}
							autoComplete="off"
							required
						/>
					</div>

					{secretFields.map((field) => {
						const values = field.kind === 'env' ? secretEnv : secretHeaders
						const setValues = field.kind === 'env' ? setSecretEnv : setSecretHeaders
						const id = `mcp-${field.kind}-${messageId}-${field.name}`
						return (
							<div key={id} className="space-y-1.5">
								<Label htmlFor={id}>{field.name}</Label>
								<SecretInput
									id={id}
									value={values[field.name] ?? ''}
									onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
								/>
							</div>
						)
					})}
					{secretFields.length > 0 ? (
						<p className="text-xs text-muted-foreground">
							What you type goes straight into the server's settings, so the agent never sees it.
						</p>
					) : null}
				</>
			)}

			{!canAdd ? (
				<p className="text-xs text-muted-foreground">Only a person can add a tool server.</p>
			) : null}
			<FormError error={error ?? undefined} />
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" size="sm" disabled={!canSubmit}>
					{busy ? 'Adding…' : savedServerId ? 'Give to this agent' : 'Add'}
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={busy} onClick={decline}>
					Not now
				</Button>
			</div>
		</form>
	)
}
