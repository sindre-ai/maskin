import Foundation
import Testing

@testable import MaskinCore

@Suite("ShellHeaderKicker")
struct ShellHeaderKickerTests {
	private var calendar: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		return calendar
	}

	@Test("UK order: weekday, day, month in upper case")
	func order() {
		let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 18, hour: 12))!
		#expect(ShellHeaderKicker.date(date, calendar: calendar, locale: Locale(identifier: "en_GB")) == "SUN 18 OCT")
	}

	@Test("US order follows the locale")
	func usLocale() {
		let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 18, hour: 12))!
		#expect(ShellHeaderKicker.date(date, calendar: calendar, locale: Locale(identifier: "en_US")) == "SUN OCT 18")
	}
}
