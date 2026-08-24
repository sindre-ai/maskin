import { buildChiefOfStaffKickoffPrompt } from '../../../lib/onboarding/chief-of-staff-kickoff'

describe('buildChiefOfStaffKickoffPrompt', () => {
	it('names the continuous-onboarding skill explicitly rather than re-describing its steps', () => {
		const prompt = buildChiefOfStaffKickoffPrompt({
			name: 'Ada Testowski',
			email: 'ada@acme.example',
		})
		expect(prompt).toContain('continuous-onboarding')
		expect(prompt).toContain('Ada Testowski')
		expect(prompt).toContain('ada@acme.example')
	})

	it('falls back gracefully when name/email are missing', () => {
		const prompt = buildChiefOfStaffKickoffPrompt({})
		expect(prompt).toContain('continuous-onboarding')
		expect(prompt).toContain('the workspace owner')
	})
})
