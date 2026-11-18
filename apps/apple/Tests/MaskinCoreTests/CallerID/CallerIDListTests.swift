import Foundation
import Testing

@testable import MaskinCore

func callerIDContact(
	_ id: String, title: String?, phone: String?, updatedAt: Date? = nil
) -> WorkObject {
	WorkObject(
		id: id, type: "contact", title: title, status: "active",
		metadata: phone.map { ["phone": $0] } ?? [:], updatedAt: updatedAt)
}

@Suite("Caller ID number tidy")
struct CallerIDNumberTests {
	@Test(
		"Messy shapes from the workspace come out as one number",
		arguments: [
			// Clean international.
			("+4512345678", 4_512_345_678),
			("+45 12 34 56 78", 4_512_345_678),
			("+45-12-34-56-78", 4_512_345_678),
			// "+45 xx xx xx xx (where we found it)".
			("+45 12 34 56 78 (from the website)", 4_512_345_678),
			("+45 12 34 56 78(LinkedIn)", 4_512_345_678),
			// "xx xx xx xx (note)".
			("12 34 56 78 (mobile)", 4_512_345_678),
			("12 34 56 78 (", 4_512_345_678),
			// A bare 8 digit number.
			("12345678", 4_512_345_678),
			("12-34-56-78", 4_512_345_678),
			// 0045 prefix.
			("0045 12 34 56 78", 4_512_345_678),
			("004512345678", 4_512_345_678),
			// Another country keeps its own code.
			("+1 202 555 0123", 12_025_550_123),
			// Edges of the 8 to 15 digit range.
			("+12345678", 12_345_678),
			("+123456789012345", 123_456_789_012_345),
			// Tabs, non-breaking spaces and leading or trailing space.
			("  +45\t12\u{00A0}34 56 78  ", 4_512_345_678),
		] as [(String, Int64)])
	func tidies(raw: String, expected: Int64) {
		#expect(CallerIDNumber.normalize(raw) == expected)
	}

	@Test(
		"Anything else is skipped",
		arguments: [
			"", "   ", "(only a note)", "n/a", "call the office",
			"1234567",  // 7 digits
			"123456789",  // 9 digits without a +
			"+1234567",  // 7 digits after +
			"+1234567890123456",  // 16 digits
			"+45 12 34 56 7x",
			"+45.12.34.56.78",
			"12 34 56 7a",
			"0045 123",
			"+",
		])
	func skips(raw: String) {
		#expect(CallerIDNumber.normalize(raw) == nil)
	}
}

@Suite("Caller ID list builder")
struct CallerIDListBuilderTests {
	@Test("A contact with a name and a number becomes one entry")
	func basic() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "Ada Lovelace", phone: "+45 12 34 56 78")
		])
		#expect(list == [CallerIDEntry(number: 4_512_345_678, label: "Ada Lovelace")])
	}

	@Test("Placeholder contacts titled Unknown caller are skipped, whatever the case")
	func placeholdersSkipped() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "Unknown caller +4512345678", phone: "+4512345678"),
			callerIDContact("b", title: "unknown caller", phone: "+4587654321"),
			callerIDContact("c", title: "Real Person", phone: "+4511111111"),
		])
		#expect(list == [CallerIDEntry(number: 4_511_111_111, label: "Real Person")])
	}

	@Test("Contacts with no name, no phone or an unusable phone are skipped")
	func unusableSkipped() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: nil, phone: "+4512345678"),
			callerIDContact("b", title: "   ", phone: "+4512345679"),
			callerIDContact("c", title: "No Phone", phone: nil),
			callerIDContact("d", title: "Bad Phone", phone: "call me"),
		])
		#expect(list.isEmpty)
	}

	@Test("A real name wins over a placeholder on the same number")
	func realNameBeatsPlaceholder() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "Unknown caller +4512345678", phone: "+4512345678"),
			callerIDContact("b", title: "Real Person", phone: "12 34 56 78 (mobile)"),
		])
		#expect(list == [CallerIDEntry(number: 4_512_345_678, label: "Real Person")])
	}

	@Test("Two spellings of one number keep one entry: the newest update, then the lower id")
	func duplicatesMerged() {
		let old = Date(timeIntervalSince1970: 1_000)
		let new = Date(timeIntervalSince1970: 2_000)
		let byDate = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "Old Name", phone: "+4512345678", updatedAt: old),
			callerIDContact("b", title: "New Name", phone: "12345678", updatedAt: new),
		])
		#expect(byDate == [CallerIDEntry(number: 4_512_345_678, label: "New Name")])

		let reversed = CallerIDListBuilder.build(from: [
			callerIDContact("b", title: "New Name", phone: "12345678", updatedAt: new),
			callerIDContact("a", title: "Old Name", phone: "+4512345678", updatedAt: old),
		])
		#expect(reversed == byDate)

		let byId = CallerIDListBuilder.build(from: [
			callerIDContact("z", title: "Zed", phone: "+4512345678"),
			callerIDContact("m", title: "Em", phone: "+4512345678"),
		])
		#expect(byId == [CallerIDEntry(number: 4_512_345_678, label: "Em")])
	}

	@Test("The list is sorted ascending by number, as a number")
	func sortedNumerically() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "US", phone: "+1 202 555 0123"),
			callerIDContact("b", title: "High", phone: "+4599999999"),
			callerIDContact("c", title: "Low", phone: "+4511111111"),
			callerIDContact("d", title: "Mid", phone: "+4550000000"),
		])
		#expect(list.map(\.label) == ["Low", "Mid", "High", "US"])
		#expect(list.map(\.number) == list.map(\.number).sorted())
	}

	@Test("Odd spacing in a name is tidied to single spaces")
	func labelWhitespace() {
		let list = CallerIDListBuilder.build(from: [
			callerIDContact("a", title: "  Ada \n  Lovelace ", phone: "+4512345678")
		])
		#expect(list.first?.label == "Ada Lovelace")
	}
}
