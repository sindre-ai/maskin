import Foundation
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

	@Test("the opening setting is saved with the other options and Expanded is not the default")
	func opening() throws {
		var options = ForYouDisplayOptions()
		#expect(options.opening == .compact)
		options.opening = .expanded
		#expect(!options.isDefaultDisplay)
		let back = try JSONDecoder().decode(ForYouDisplayOptions.self, from: JSONEncoder().encode(options))
		#expect(back.opening == .expanded)
		options.resetDisplay()
		#expect(options.opening == .compact)
	}

	@Test("any changed display setting is not the default, and reset puts them back but keeps the intent")
	func reset() {
		var options = ForYouDisplayOptions(opening: .expanded, intent: .approvals, filterBarOn: true)
		#expect(!options.isDefaultDisplay)
		options.resetDisplay()
		#expect(options.isDefaultDisplay)
		#expect(options.intent == .approvals)
	}
}
