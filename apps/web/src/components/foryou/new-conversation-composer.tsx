import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useBets } from '@/hooks/use-bets'
import { useCreateSession } from '@/hooks/use-sessions'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

interface NewConversationComposerProps {
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

const BET_NONE = '__none__'

export function NewConversationComposer({
	workspaceId,
	open,
	onOpenChange,
}: NewConversationComposerProps) {
	const navigate = useNavigate()
	const [agentId, setAgentId] = useState<string>('')
	const [betId, setBetId] = useState<string>(BET_NONE)
	const [message, setMessage] = useState('')
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const { data: actors } = useActors(workspaceId, { enabled: open })
	const { data: bets } = useBets(workspaceId)
	const createSession = useCreateSession(workspaceId)

	const agents = useMemo(
		() => (actors ?? []).filter((a) => a.type === 'agent' && !a.isSystem),
		[actors],
	)
	const openBets = useMemo(
		() => (bets ?? []).filter((b) => b.status !== 'closed' && b.title),
		[bets],
	)

	useEffect(() => {
		if (!open) {
			setAgentId('')
			setBetId(BET_NONE)
			setMessage('')
		}
	}, [open])

	useEffect(() => {
		if (open && textareaRef.current) {
			const t = setTimeout(() => textareaRef.current?.focus(), 50)
			return () => clearTimeout(t)
		}
	}, [open])

	const canSubmit = agentId !== '' && message.trim().length > 0 && !createSession.isPending

	const handleSubmit = useCallback(() => {
		const trimmed = message.trim()
		if (!agentId || !trimmed) return

		const selectedBet = betId !== BET_NONE ? openBets.find((b) => b.id === betId) : null
		const actionPrompt = selectedBet
			? `Context: bet "${selectedBet.title}" (${selectedBet.id}).\n\n${trimmed}`
			: trimmed

		createSession.mutate(
			{ actor_id: agentId, action_prompt: actionPrompt },
			{
				onSuccess: (session) => {
					toast('Conversation started')
					onOpenChange(false)
					navigate({
						to: '/$workspaceId/agents/$agentId',
						params: { workspaceId, agentId },
						search: { sessionId: session.id } as never,
					}).catch(() => {
						// Route may not accept search param — silently ignore navigation failure.
					})
				},
				onError: (err) => {
					toast.error(err instanceof Error ? err.message : 'Failed to start conversation')
				},
			},
		)
	}, [agentId, betId, message, openBets, createSession, navigate, onOpenChange, workspaceId])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				if (canSubmit) handleSubmit()
			}
		},
		[canSubmit, handleSubmit],
	)

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="sm:max-w-[520px]">
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>New conversation</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Start a new thread with an agent. Optionally anchor it to a bet for context.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<label htmlFor="composer-agent" className="text-xs font-medium text-foreground">
							Agent
						</label>
						<Select value={agentId} onValueChange={setAgentId}>
							<SelectTrigger id="composer-agent" className="w-full" aria-label="Agent">
								<SelectValue placeholder="Pick an agent" />
							</SelectTrigger>
							<SelectContent>
								{agents.length === 0 ? (
									<SelectItem value="__empty__" disabled>
										No agents available
									</SelectItem>
								) : (
									agents.map((a) => (
										<SelectItem key={a.id} value={a.id}>
											{a.name}
										</SelectItem>
									))
								)}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<label htmlFor="composer-bet" className="text-xs font-medium text-foreground">
							Bet <span className="text-muted-foreground">(optional)</span>
						</label>
						<Select value={betId} onValueChange={setBetId}>
							<SelectTrigger id="composer-bet" className="w-full" aria-label="Bet">
								<SelectValue placeholder="No bet" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={BET_NONE}>No bet</SelectItem>
								{openBets.map((b) => (
									<SelectItem key={b.id} value={b.id}>
										{b.title ?? '(untitled)'}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<label htmlFor="composer-message" className="text-xs font-medium text-foreground">
							Message
						</label>
						<Textarea
							id="composer-message"
							ref={textareaRef}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="What do you want the agent to do?"
							autoResize
							className="min-h-[120px]"
						/>
					</div>
				</div>
				<ResponsiveDialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={!canSubmit}>
						{createSession.isPending ? 'Starting…' : 'Start conversation'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
