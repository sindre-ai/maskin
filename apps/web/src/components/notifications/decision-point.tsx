import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useState } from 'react'

interface DecisionOption {
	label: string
	value: string
	description?: string
}

interface DecisionPointProps {
	question: string
	options: DecisionOption[]
	onConfirm: (value: string) => void
}

export function DecisionPoint({ question, options, onConfirm }: DecisionPointProps) {
	const [selected, setSelected] = useState<string>('')

	return (
		<Card className="mt-3">
			<CardContent className="pt-4 pb-4">
				<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
					Decision point
				</p>
				<p className="text-sm font-medium mb-3">{question}</p>
				<RadioGroup value={selected} onValueChange={setSelected} className="space-y-2 mb-3">
					{options.map((opt) => (
						<div
							key={opt.value}
							className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent hover:text-accent-foreground"
							onClick={() => setSelected(opt.value)}
							onKeyDown={(e) => e.key === 'Enter' && setSelected(opt.value)}
						>
							<RadioGroupItem value={opt.value} id={opt.value} className="mt-0.5" />
							<Label htmlFor={opt.value} className="cursor-pointer flex-1">
								<span className="text-sm font-medium">{opt.label}</span>
								{opt.description && (
									<span className="block text-xs text-muted-foreground">{opt.description}</span>
								)}
							</Label>
						</div>
					))}
				</RadioGroup>
				<Button size="sm" disabled={!selected} onClick={() => onConfirm(selected)}>
					Confirm
				</Button>
			</CardContent>
		</Card>
	)
}
