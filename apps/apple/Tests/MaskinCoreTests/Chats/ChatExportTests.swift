import Foundation
import Testing

@testable import MaskinCore

@Suite("ChatExport")
struct ChatExportTests {
	private func message(_ id: String, _ name: String, _ text: String, kind: String = "message",
		status: ChatMessage.Status = .sent) -> ChatMessage {
		ChatMessage(
			id: id, conversationID: "c", actorID: id, actorName: name, author: .human, kind: kind,
			content: text, createdAt: Date(timeIntervalSince1970: 1_700_000_000), status: status)
	}

	@Test("writes the title, then each message under its author")
	func basic() {
		let md = ChatExport.markdown(
			title: "Pricing review",
			messages: [message("1", "Bente", "Hello"), message("2", "Strategist", "Hi")])
		#expect(md.hasPrefix("# Pricing review\n"))
		#expect(md.contains("**Bente**"))
		#expect(md.contains("Hello"))
		#expect(md.contains("**Strategist**"))
	}

	@Test("leaves out failed and empty messages, italicises dividers")
	func filters() {
		let md = ChatExport.markdown(
			title: "",
			messages: [
				message("1", "A", "kept"), message("2", "A", "lost", status: .failed("x")),
				message("3", "A", "  "), message("4", "", "Live meeting started", kind: "system"),
			])
		#expect(md.hasPrefix("# Chat\n"))
		#expect(!md.contains("lost"))
		#expect(md.contains("_Live meeting started_"))
	}
}
