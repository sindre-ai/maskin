import Testing

@testable import MaskinCore

@Suite("Shell badge text")
struct ShellBadgeTextTests {
	@Test("nothing at zero or below")
	func none() {
		#expect(ShellBadgeText.text(count: 0) == nil)
		#expect(ShellBadgeText.text(count: -3) == nil)
	}

	@Test("the count up to 99, then 99+")
	func capped() {
		#expect(ShellBadgeText.text(count: 1) == "1")
		#expect(ShellBadgeText.text(count: 99) == "99")
		#expect(ShellBadgeText.text(count: 100) == "99+")
		#expect(ShellBadgeText.text(count: 4000) == "99+")
	}
}
