import Foundation
import Testing

@testable import MaskinCore

@Suite("Chats Display")
struct ChatsDisplayTests {
	@Test("choices saved before the new properties existed still decode with them on")
	func decodesLegacy() throws {
		let data = Data(#"{"layout":"oneList","grouping":"byPerson","showsFilterChips":true}"#.utf8)
		let options = try JSONDecoder().decode(TeamDisplayOptions.self, from: data)
		#expect(options.layout == .oneList && options.grouping == .byPerson && options.showsFilterChips)
		#expect(!options.unreadOnly && options.showsPreview && options.showsWorkingLine)
	}

	@Test("Sections and None are the grouped layout and the single list")
	func sections() {
		var options = TeamDisplayOptions.default
		#expect(options.isSectioned && !options.isCustomised)
		options.isSectioned = false
		#expect(options.layout == .oneList && options.isCustomised)
	}

	@Test("the Agents / Recent switch is the Agents grouping or the flat newest-first one, and Agents is the default")
	func listView() {
		var options = TeamDisplayOptions.default
		#expect(options.listView == .agents && options.grouping == .byAgent)
		options.listView = .recent
		#expect(options.grouping == .newestFirst && options.isCustomised)
		options.listView = .agents
		#expect(!options.isCustomised)
		options.grouping = .byTime
		#expect(options.listView == .recent, "any other grouping reads as Recent")
	}

	@Test("choices saved before Agents existed keep their grouping, and a record with none reads by date")
	func decodesGrouping() throws {
		let none = try JSONDecoder().decode(TeamDisplayOptions.self, from: Data(#"{"layout":"sections"}"#.utf8))
		#expect(none.grouping == .byTime)
		let saved = try JSONDecoder().decode(TeamDisplayOptions.self, from: Data(#"{"grouping":"byTime"}"#.utf8))
		#expect(saved.listView == .recent)
	}

	@Test("the Unread filter wins over the chip row")
	func effectiveChip() {
		var options = TeamDisplayOptions.default
		#expect(ConversationsStore.effectiveChip(options, .people) == .all)
		options.showsFilterChips = true
		#expect(ConversationsStore.effectiveChip(options, .people) == .people)
		options.unreadOnly = true
		#expect(ConversationsStore.effectiveChip(options, .people) == .unread)
	}

	@Test("hiding the working line keeps the preview; hiding the preview keeps the working line")
	func properties() {
		var working = ConversationRowStatus(prefix: .working(1), preview: "Rebasing the branch")
		var options = TeamDisplayOptions.default
		options.showsWorkingLine = false
		var shown = working.applying(options)
		#expect(shown.prefix == nil && shown.preview == "Rebasing the branch")
		options = .default
		options.showsPreview = false
		shown = working.applying(options)
		#expect(shown.prefix == .working(1) && shown.preview.isEmpty)
		working = ConversationRowStatus(prefix: .typing, preview: "")
		options.showsWorkingLine = false
		#expect(working.applying(options).prefix == nil)
	}
}
