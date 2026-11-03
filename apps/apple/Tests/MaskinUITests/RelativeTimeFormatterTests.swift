import Foundation
import Testing

@testable import MaskinUI

@Suite("RelativeTimeFormatter") struct RelativeTimeFormatterTests {
	static let calendar: Calendar = {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(secondsFromGMT: 0)!
		return c
	}()
	static let locale = Locale(identifier: "en_US")
	// Wed 2026-07-15 14:12:00 UTC
	static let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 15, hour: 14, minute: 12))!

	func relative(_ secondsAgo: Int) -> String {
		RelativeTimeFormatter.string(
			for: Self.now.addingTimeInterval(-Double(secondsAgo)), now: Self.now, style: .relative,
			calendar: Self.calendar, locale: Self.locale)
	}

	func compact(_ secondsAgo: Int, dayLimit: Int = 30) -> String {
		RelativeTimeFormatter.string(
			for: Self.now.addingTimeInterval(-Double(secondsAgo)), now: Self.now, style: .compact,
			compactDayLimit: dayLimit, calendar: Self.calendar, locale: Self.locale)
	}

	@Test func relativeBoundaries() {
		#expect(relative(0) == "now")
		#expect(relative(9) == "now")
		#expect(relative(10) == "10s ago")
		#expect(relative(59) == "59s ago")
		#expect(relative(60) == "1m ago")
		#expect(relative(3599) == "59m ago")
		#expect(relative(3600) == "1h ago")
		#expect(relative(86_399) == "23h ago")
		#expect(relative(86_400) == "1d ago")
		#expect(relative(29 * 86_400) == "29d ago")
		#expect(relative(30 * 86_400) == "Jun 15, 2026")
	}

	@Test func futureDatesReadAsNow() {
		#expect(relative(-30) == "now")
		#expect(compact(-30) == "now")
	}

	@Test func compactBoundaries() {
		#expect(compact(59) == "now")
		#expect(compact(60) == "1m")
		#expect(compact(3600) == "1h")
		#expect(compact(86_400) == "1d")
		#expect(compact(6 * 86_400, dayLimit: 7) == "6d")
		#expect(compact(7 * 86_400, dayLimit: 7) == "Jul 8")
		#expect(compact(30 * 86_400) == "Jun 15")
	}

	func clock(daysAgo: Int, hour: Int = 8, minute: Int = 44) -> String {
		var parts = DateComponents(year: 2026, month: 7, day: 15 - daysAgo, hour: hour, minute: minute)
		parts.timeZone = Self.calendar.timeZone
		return RelativeTimeFormatter.string(
			for: Self.calendar.date(from: parts)!, now: Self.now, style: .clock,
			calendar: Self.calendar, locale: Self.locale)
	}

	@Test func clockForm() {
		#expect(clock(daysAgo: 0) == "08:44")
		#expect(clock(daysAgo: 1) == "TUE 08:44")
		#expect(clock(daysAgo: 6) == "THU 08:44")
		#expect(clock(daysAgo: 7) == "JUL 8")
	}
}
