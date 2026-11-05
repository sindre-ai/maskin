import Foundation
import Testing

@testable import MaskinCore

@Suite("PropertyValueEncoding")
struct PropertyValueEncodingTests {
	@Test func writesDatesAsIsoDays() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		let date = Date(timeIntervalSince1970: 1_762_041_600)  // 2025-11-02
		#expect(PropertyValueEncoding.dateString(date, calendar: calendar) == "2025-11-02")
	}

	@Test func writesBooleans() {
		#expect(PropertyValueEncoding.boolString(true) == "true")
		#expect(PropertyValueEncoding.boolString(false) == "false")
	}

	@Test func rejectsEmptyAndNonNumericNumbers() {
		#expect(PropertyValueEncoding.normalized("  ", kind: .text) == nil)
		#expect(PropertyValueEncoding.normalized("abc", kind: .number) == nil)
		#expect(PropertyValueEncoding.normalized("12,5", kind: .number) == "12.5")
		#expect(PropertyValueEncoding.normalized(" hi ", kind: .text) == "hi")
	}
}
