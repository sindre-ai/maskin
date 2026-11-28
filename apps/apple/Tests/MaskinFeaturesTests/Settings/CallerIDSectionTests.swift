#if os(iOS)
	import MaskinCore
	import Testing

	@testable import MaskinFeatures

	@Suite("CallerIDSection")
	struct CallerIDSectionTests {
		@Test("the row says what the phone says, and counts the numbers loaded")
		func copy() {
			#expect(CallerIDSection.statusTitle(.enabled) == "On")
			#expect(CallerIDSection.statusTitle(.disabled) == "Off")
			#expect(CallerIDSection.statusTitle(.unknown) == "Not known")
			#expect(CallerIDSection.summary(for: .enabled, count: 1065) == "1065 numbers loaded")
			#expect(CallerIDSection.summary(for: .enabled, count: 1) == "1 number loaded")
			#expect(CallerIDSection.summary(for: .enabled, count: 0) == "On, but no names are loaded yet")
		}

		@Test("the switch-on steps are the three the spec names")
		func steps() {
			#expect(CallerIDSection.steps.count == 3)
			#expect(CallerIDSection.steps.joined(separator: " ").contains("Call Blocking and Identification"))
		}
	}
#endif
