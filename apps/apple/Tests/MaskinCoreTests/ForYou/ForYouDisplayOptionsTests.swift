import Testing

@testable import MaskinCore

@Suite("ForYouDisplayOptions")
struct ForYouDisplayOptionsTests {
	@Test("the defaults count as unchanged, and an intent pill does not")
	func defaults() {
		var options = ForYouDisplayOptions()
		#expect(options.isDefaultDisplay)
		options.intent = .approvals
		#expect(options.isDefaultDisplay)
	}

	@Test("any changed display setting is not the default, and reset puts them back but keeps the intent")
	func reset() {
		var options = ForYouDisplayOptions(mode: .list, sort: .latest, intent: .approvals, filterBarOn: true, showsHandled: false)
		#expect(!options.isDefaultDisplay)
		options.resetDisplay()
		#expect(options.isDefaultDisplay)
		#expect(options.intent == .approvals)
	}
}
