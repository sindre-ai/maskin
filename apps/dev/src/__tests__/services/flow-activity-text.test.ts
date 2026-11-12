import { describe, expect, it } from 'vitest'
import { buildFlowActivityEmail, flowRunLine } from '../../services/flow-activity-text'

const base = {
	flowName: 'Weekly research',
	buttonUrl: 'https://maskin.test/ws/loops/f1?surface=email',
	stopUrl: 'https://maskin.test/api/email/stop?token=t',
}

describe('flow activity email text', () => {
	it('names the flow, lists the runs the way the summary does, and has one button and a stop link', () => {
		const mail = buildFlowActivityEmail({
			...base,
			runs: [
				{ agentName: 'Researcher', objectTitle: 'Competitor update' },
				{ agentName: 'Writer', objectTitle: null },
			],
			runCount: 2,
		})
		expect(mail.subject).toBe('Weekly research: 2 runs finished')
		expect(mail.text).toContain("- Researcher finished 'Competitor update'")
		expect(mail.text).toContain('- Writer finished a task')
		expect(mail.text).toContain(`Open the flow: ${base.buttonUrl}`)
		expect(mail.text).toContain(`Stop these emails: ${base.stopUrl}`)
		expect(mail.html.match(/Open the flow/g)).toHaveLength(1)
		expect(mail.headers).toEqual({
			'List-Unsubscribe': `<${base.stopUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		})
	})

	it('says "1 run finished" for one, and counts the rest past five', () => {
		const one = buildFlowActivityEmail({
			...base,
			runs: [{ agentName: 'A', objectTitle: 'T' }],
			runCount: 1,
		})
		expect(one.subject).toBe('Weekly research: 1 run finished')

		const runs = Array.from({ length: 5 }, (_, i) => ({ agentName: 'A', objectTitle: `T${i}` }))
		const many = buildFlowActivityEmail({ ...base, runs, runCount: 8 })
		expect(many.subject).toBe('Weekly research: 8 runs finished')
		expect(many.text).toContain('- and 3 more')
	})

	it('claims only that runs finished and escapes titles in the html', () => {
		const mail = buildFlowActivityEmail({
			...base,
			runs: [{ agentName: 'A', objectTitle: '<b>x</b>' }],
			runCount: 1,
		})
		expect(mail.html).not.toContain('<b>x</b>')
		expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;')
		expect(mail.text).not.toMatch(/succe|fail|result/i)
	})

	it('clips a long run title', () => {
		const line = flowRunLine({ agentName: 'A', objectTitle: 'x'.repeat(200) })
		expect(line.length).toBeLessThan(100)
	})

	it('shows each run with a tick and previews the first run, not the subject', () => {
		const mail = buildFlowActivityEmail({
			...base,
			runs: [{ agentName: 'Researcher', objectTitle: 'Competitor update' }],
			runCount: 1,
		})
		expect(mail.html).toContain('&#10003;')
		const preview = mail.html.match(/display: none[^>]*>([^<]*)</)?.[1] as string
		expect(preview).toContain('Researcher finished &#39;Competitor update&#39;')
		expect(preview).not.toContain(mail.subject)
	})
})
