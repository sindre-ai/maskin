import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'

interface InputOption {
	label: string
	value: string
	description?: string
}

interface NotificationInputProps {
	metadata: Record<string, unknown>
	onSubmit: (response: unknown) => void
}

export function NotificationInput({ metadata, onSubmit }: NotificationInputProps) {
	const inputType = metadata.input_type as string
	const question = metadata.question as string | undefined
	const options = metadata.options as InputOption[] | undefined
	const placeholder = metadata.placeholder as string | undefined

	const [singleValue, setSingleValue] = useState('')
	const [multiValues, setMultiValues] = useState<Set<string>>(new Set())
	const [textValue, setTextValue] = useState('')

	const toggleMulti = (value: string) => {
		setMultiValues((prev) => {
			const next = new Set(prev)
			if (next.has(value)) next.delete(value)
			else next.add(value)
			return next
		})
	}

	return (
		<Card className="mt-3">
			<CardContent className="pt-4 pb-4">
				<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
					{inputType === 'confirmation' ? 'Confirmation' : 'Decision point'}
				</p>
				{question && <p className="text-sm font-medium mb-3">{question}</p>}

				{/* Single choice — radio buttons */}
				{inputType === 'single_choice' && options && (
					<>
						<RadioGroup
							value={singleValue}
							onValueChange={setSingleValue}
							className="space-y-2 mb-3"
						>
							{options.map((opt) => (
								<div
									key={opt.value}
									className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent"
									onClick={() => setSingleValue(opt.value)}
									onKeyDown={(e) => e.key === 'Enter' && setSingleValue(opt.value)}
								>
									<RadioGroupItem value={opt.value} id={`sc-${opt.value}`} className="mt-0.5" />
									<Label htmlFor={`sc-${opt.value}`} className="cursor-pointer flex-1">
										<span className="text-sm font-medium">{opt.label}</span>
										{opt.description && (
											<span className="block text-xs text-muted-foreground">{opt.description}</span>
										)}
									</Label>
								</div>
							))}
						</RadioGroup>
						<Button size="sm" disabled={!singleValue} onClick={() => onSubmit(singleValue)}>
							Confirm
						</Button>
					</>
				)}

				{/* Multiple choice — checkboxes */}
				{inputType === 'multiple_choice' && options && (
					<>
						<div className="space-y-2 mb-3">
							{options.map((opt) => (
								<div
									key={opt.value}
									className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent"
									onClick={() => toggleMulti(opt.value)}
									onKeyDown={(e) => e.key === 'Enter' && toggleMulti(opt.value)}
								>
									<Checkbox
										id={`mc-${opt.value}`}
										checked={multiValues.has(opt.value)}
										onCheckedChange={() => toggleMulti(opt.value)}
										className="mt-0.5"
									/>
									<Label htmlFor={`mc-${opt.value}`} className="cursor-pointer flex-1">
										<span className="text-sm font-medium">{opt.label}</span>
										{opt.description && (
											<span className="block text-xs text-muted-foreground">{opt.description}</span>
										)}
									</Label>
								</div>
							))}
						</div>
						<Button
							size="sm"
							disabled={multiValues.size === 0}
							onClick={() => onSubmit([...multiValues])}
						>
							Confirm
						</Button>
					</>
				)}

				{/* Text input */}
				{inputType === 'text' && (
					<>
						{(metadata.multiline as boolean) ? (
							<Textarea
								value={textValue}
								onChange={(e) => setTextValue(e.target.value)}
								placeholder={placeholder ?? 'Type your response...'}
								className="mb-3"
								rows={3}
							/>
						) : (
							<Input
								value={textValue}
								onChange={(e) => setTextValue(e.target.value)}
								placeholder={placeholder ?? 'Type your response...'}
								className="mb-3"
							/>
						)}
						<Button size="sm" disabled={!textValue.trim()} onClick={() => onSubmit(textValue)}>
							Submit
						</Button>
					</>
				)}

				{/* Confirmation — yes/no */}
				{inputType === 'confirmation' && (
					<div className="flex gap-2">
						<Button size="sm" onClick={() => onSubmit(true)}>
							Yes
						</Button>
						<Button size="sm" variant="outline" onClick={() => onSubmit(false)}>
							No
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	)
}
