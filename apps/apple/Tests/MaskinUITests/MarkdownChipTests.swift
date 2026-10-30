import MaskinDesign
import SwiftUI
import Testing

@testable import MaskinUI

@Suite("Markdown chip name and dots") struct MarkdownChipTests {
	// MARK: Name

	@Test func aShortTitleIsShownWhole() {
		#expect(MarkdownChip.shortName("Launch video") == "Launch video")
		#expect(MarkdownChip.shortName("  Launch video \n") == "Launch video")
	}

	@Test func onlyTheTextBeforeALongDashShows() {
		#expect(MarkdownChip.shortName("David Harboe \u{2014} Norlix (CTO & Co-founder)") == "David Harboe")
		// A short dash or a dash with no spaces around it is part of the name.
		#expect(MarkdownChip.shortName("Q3 - plan") == "Q3 - plan")
		#expect(MarkdownChip.shortName("Q3\u{2014}plan") == "Q3\u{2014}plan")
	}

	@Test func aTitleThatStartsWithTheDashKeepsItsWords() {
		#expect(MarkdownChip.shortName(" \u{2014} later") == "\u{2014} later")
	}

	@Test func aTitleOf90CharactersIsNotCut() {
		let title = String(repeating: "a", count: 90)
		#expect(MarkdownChip.shortName(title) == title)
	}

	@Test func aLongTitleIsCutAtTheLastSpaceBefore90WhenThatIsPast60() {
		let words = (0..<30).map { _ in "abcd" }.joined(separator: " ")  // 149 characters, a space every 5
		let name = MarkdownChip.shortName(words)
		#expect(name.hasSuffix("\u{2026}"))
		#expect(name.count <= 91)
		#expect(name.count > 60)
		#expect(!name.dropLast().hasSuffix(" "))
		// It lands on a word end, not in the middle of one.
		#expect(name.dropLast().hasSuffix("abcd"))
	}

	@Test func aLongTitleWithNoSpacePast60IsCutAt90() {
		let title = "short words " + String(repeating: "x", count: 120)
		let name = MarkdownChip.shortName(title)
		#expect(name == String(title.prefix(90)) + "\u{2026}")
	}

	@Test func theDashRuleRunsBeforeTheLengthRule() {
		let title = "Short \u{2014} " + String(repeating: "word ", count: 40)
		#expect(MarkdownChip.shortName(title) == "Short")
	}

	// MARK: Status dot

	@Test(
		"the dot follows the status tone",
		arguments: [
			("in_progress", MarkdownChip.StatusDot.patina), ("active", .patina), ("live", .patina),
			("in_review", .patina), ("blocked", .patina),
			("done", .ink), ("completed", .ink),
			("failed", .warning), ("at_risk", .warning),
			("todo", .grey), ("backlog", .grey), ("parked", .grey), ("some_custom_status", .grey),
		])
	func dotTone(status: String, expected: MarkdownChip.StatusDot) {
		#expect(MarkdownChip.statusDot(for: status) == expected)
	}

	@Test func noStatusMeansNoDot() {
		#expect(MarkdownChip.statusDot(for: nil) == nil)
		#expect(MarkdownChip.statusDot(for: "") == nil)
		#expect(MarkdownChip.statusDot(for: "  ") == nil)
	}

	@Test func theTypeDotKeepsItsHueForFourTypesAndIsGreyForTheRest() {
		for type in ["insight", "bet", "task", "doc"] {
			#expect(MaskinObjectType.dotColor(for: type) != MaskinColor.ink5)
		}
		for type in ["person", "company", "meeting", "custom_thing"] {
			#expect(MaskinObjectType.dotColor(for: type) == MaskinColor.ink5)
		}
	}
}

@Suite("MarkdownInline object chips") struct MarkdownInlineChipTests {
	private let url = "https://maskin.io/ws/objects/abc"

	private func render(_ md: String, info: MarkdownLinkInfo, onInverse: Bool = false) -> AttributedString {
		MarkdownInline.attributed(md, base: .body, linkInfo: { _ in info }, onInverse: onInverse)
	}

	private func text(_ attr: AttributedString) -> String { String(attr.characters) }

	private let task = MarkdownLinkInfo(
		symbol: "checkmark.square", kindLabel: "Task", title: "Fix login \u{2014} iOS only", objectType: "task",
		status: "in_progress")

	@Test func aLoadedObjectIsATypeDotTheShortNameAndAStatusDot() {
		let attr = render("see [the fix](\(url)) now", info: task)
		#expect(text(attr) == "see \u{25CF} Fix login \u{25CF} now")
	}

	@Test func theWholeChipIsOneTappableLink() {
		let attr = render("[the fix](\(url))", info: task)
		let links = attr.runs.compactMap { $0.link }
		#expect(!links.isEmpty)
		#expect(links.allSatisfy { $0.absoluteString == url })
		#expect(attr.runs.allSatisfy { $0.link != nil && $0.underlineStyle == nil && $0.backgroundColor != nil })
	}

	@Test func theDotsCarryTheTypeAndStatusColours() {
		let attr = render("[x](\(url))", info: task)
		let dots = attr.runs.filter { String(attr[$0.range].characters) == "\u{25CF}" }
		#expect(dots.count == 2)
		#expect(dots.first?.foregroundColor == MaskinObjectType.dotColor(for: "task"))
		#expect(dots.last?.foregroundColor == MaskinStatus.patina.fg)
	}

	@Test func anObjectWithNoStatusHasNoStatusDot() {
		var info = task
		info.status = nil
		#expect(text(render("[x](\(url))", info: info)) == "\u{25CF} Fix login")
	}

	@Test func inYourOwnBubbleBothDotsAreOnInkAtSeventyPercent() {
		let attr = render("[x](\(url))", info: task, onInverse: true)
		let dots = attr.runs.filter { String(attr[$0.range].characters) == "\u{25CF}" }
		let expected = MaskinSurface.onInverse.opacity(0.7)
		#expect(dots.count == 2)
		#expect(dots.allSatisfy { $0.foregroundColor == expected })
	}

	@Test func whileLoadingItKeepsTheAuthorsWordsBehindAGreyDot() {
		let info = MarkdownLinkInfo(symbol: "doc.text", kindLabel: "Object", phase: .loading)
		let attr = render("[the plan](\(url))", info: info)
		#expect(text(attr) == "\u{25CF} the plan")
		#expect(attr.runs.first?.foregroundColor == MaskinColor.ink5)
		#expect(text(render("\(url)", info: info)) == "\u{25CF} Object")
	}

	@Test func aDeletedObjectIsMutedItalicTextWithNoLinkAndNoTint() {
		let info = MarkdownLinkInfo(symbol: "trash", kindLabel: "Object", phase: .deleted)
		let attr = render("[the plan](\(url))", info: info)
		#expect(text(attr) == "Deleted object")
		#expect(attr.runs.allSatisfy { $0.link == nil && $0.backgroundColor == nil })
		#expect(attr.runs.first?.foregroundColor == MaskinColor.ink4)
	}

	@Test func anObjectThatCannotBeReadNowKeepsTheTintedChipWithNoDots() {
		let info = MarkdownLinkInfo(symbol: "doc.text", kindLabel: "Object")
		#expect(text(render("[the plan](\(url))", info: info)) == "the plan")
		#expect(text(render("\(url)", info: info)) == "Object")
	}

	@Test func aChatOrAgentLinkIsNameOnlyWithNoDots() {
		let info = MarkdownLinkInfo(symbol: "bubble.left", kindLabel: "Chat")
		#expect(text(render("[standup](\(url))", info: info)) == "standup")
	}
}
