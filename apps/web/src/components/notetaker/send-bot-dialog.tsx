import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSendBot } from '@/hooks/use-notetaker'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'

interface SendBotDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function SendBotDialog({ open, onOpenChange }: SendBotDialogProps) {
	const { workspaceId } = useWorkspace()
	const sendBot = useSendBot(workspaceId)
	const [meetingUrl, setMeetingUrl] = useState('')
	const [title, setTitle] = useState('')

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!meetingUrl.trim()) return

		sendBot.mutate(
			{ meeting_url: meetingUrl.trim(), title: title.trim() || undefined },
			{
				onSuccess: () => {
					setMeetingUrl('')
					setTitle('')
					onOpenChange(false)
				},
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Send bot to meeting</DialogTitle>
						<DialogDescription>Enter a meeting URL to dispatch a notetaker bot.</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="meeting-url">Meeting URL</Label>
							<Input
								id="meeting-url"
								placeholder="https://meet.google.com/abc-def-ghi"
								value={meetingUrl}
								onChange={(e) => setMeetingUrl(e.target.value)}
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="meeting-title">Title (optional)</Label>
							<Input
								id="meeting-title"
								placeholder="Team standup"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!meetingUrl.trim() || sendBot.isPending}>
							{sendBot.isPending ? 'Sending...' : 'Send bot'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
