import { buildReturnMessage } from '../../services/helper-return'

const base = {
	kind: 'completed' as const,
	helperName: 'Gig Scout',
	sessionId: '11111111-1111-4111-8111-111111111111',
	agentUrl: 'http://localhost/agent',
	reason: null,
	finalMessage: { text: '> I would search Jobindex first.', truncated: false },
}

describe('buildReturnMessage', () => {
	it('says the final message is the complete result, so the sender does not go reading logs', () => {
		const text = buildReturnMessage(base)
		expect(text).toContain('complete result')
		expect(text).toContain('no need to read its session or logs')
		expect(text).toContain('I would search Jobindex first.')
	})

	it('tells the sender what the person was asked and what they answered', () => {
		const text = buildReturnMessage({
			...base,
			exchange: [{ question: 'Which job board should I try first?', answer: 'Jobindex' }],
		})
		expect(text).toContain('Which job board should I try first? -> Jobindex')
		expect(text).toContain('this happened in your chat')
	})

	it('says so when a question has no recorded answer', () => {
		const text = buildReturnMessage({
			...base,
			exchange: [{ question: 'Which job board?', answer: null }],
		})
		expect(text).toContain('Which job board? -> no answer was recorded')
	})

	it('adds nothing about questions when none were asked', () => {
		expect(buildReturnMessage({ ...base, exchange: [] })).not.toContain('asked the person')
	})
})
