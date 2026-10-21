import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActors, useDefaultChatAgent } from '@/hooks/use-actors'
import { useMemo, useState } from 'react'

const LAST_AGENT_KEY = 'desktop-teach-agent'

function readLastAgent(): string | null {
	try {
		return localStorage.getItem(LAST_AGENT_KEY)
	} catch {
		return null
	}
}

function rememberAgent(id: string): void {
	try {
		localStorage.setItem(LAST_AGENT_KEY, id)
	} catch {
		// Storage can be blocked (private window); the choice just isn't remembered.
	}
}

export type TeachStartInput = { agentId: string; agentName: string; description: string }

/**
 * Asks which agent should learn the task and what is about to be shown, then
 * hands off to the recorder. The agent is the one that writes the skill and gets
 * it attached, so the person decides whose skill set grows.
 */
export function TeachDialog({
	open,
	onOpenChange,
	workspaceId,
	onStart,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	onStart: (input: TeachStartInput) => void
}) {
	const { data: actors } = useActors(workspaceId, { enabled: open })
	const defaultAgent = useDefaultChatAgent()
	const agents = useMemo(
		() =>
			(actors ?? []).filter((a) => a.type === 'agent').sort((a, b) => a.name.localeCompare(b.name)),
		[actors],
	)
	const [picked, setPicked] = useState<string | null>(null)
	const [description, setDescription] = useState('')

	// The person's explicit pick wins; otherwise the last agent they taught, then
	// the workspace's default agent, then the first one.
	const agentId = useMemo(() => {
		if (picked && agents.some((a) => a.id === picked)) return picked
		const last = readLastAgent()
		if (last && agents.some((a) => a.id === last)) return last
		if (defaultAgent && agents.some((a) => a.id === defaultAgent.id)) return defaultAgent.id
		return agents[0]?.id ?? ''
	}, [picked, agents, defaultAgent])

	const agent = agents.find((a) => a.id === agentId)
	const trimmed = description.trim()
	const canStart = !!agent && trimmed.length >= 3

	function handleStart(e: React.FormEvent) {
		e.preventDefault()
		if (!agent || !canStart) return
		rememberAgent(agent.id)
		onStart({ agentId: agent.id, agentName: agent.name, description: trimmed })
		setDescription('')
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={handleStart} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Teach a task</DialogTitle>
						<DialogDescription>
							Show an agent how to do something once, on this desktop. It turns what you do into a
							skill it can run on its own later.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="teach-agent">Which agent should learn it?</Label>
						<Select value={agentId} onValueChange={setPicked} disabled={agents.length === 0}>
							<SelectTrigger id="teach-agent">
								<SelectValue
									placeholder={agents.length === 0 ? 'No agents yet' : 'Pick an agent'}
								/>
							</SelectTrigger>
							<SelectContent>
								{agents.map((a) => (
									<SelectItem key={a.id} value={a.id}>
										{a.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="teach-description">What are you about to show?</Label>
						<Textarea
							id="teach-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="e.g. Export last week's report from the dashboard as a PDF"
							rows={3}
							maxLength={2000}
						/>
					</div>

					<p className="text-xs text-muted-foreground">
						Everything you click and type on the desktop is recorded, including anything you type
						into a password field, and the agent will see it. Don't enter real credentials while
						teaching. Screenshots are deleted once the agent has finished learning, and recording
						stops by itself after 10 minutes.
					</p>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!canStart}>
							Start recording
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
