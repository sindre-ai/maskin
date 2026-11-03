import Foundation
import Testing

@testable import MaskinCore

@Suite("Chat Markdown export")
struct ChatMarkdownExportTests {
	private func message(_ id: String, _ actor: String, _ kind: ChatParticipant.Kind, _ text: String, at seconds: TimeInterval, system: Bool = false) -> ChatMessage {
		.confirmed(
			serverID: Int(id) ?? 0, conversationID: "c", actorID: actor, actorName: actor.capitalized, author: kind,
			kind: system ? "system" : "message", content: text, createdAt: Date(timeIntervalSince1970: seconds))
	}

	@Test func summaryCountsMessagesPeopleAndAgents() {
		let all = [
			message("1", "ann", .human, "Hi", at: 1), message("2", "bob", .human, "Yo", at: 2),
			message("3", "dev", .agent, "On it", at: 3), message("4", "dev", .agent, "Done", at: 4),
		]
		#expect(ChatMarkdownExport.summary(of: all) == "4 messages from 2 people and 1 agent")
	}

	@Test func exportsOldestFirstAndSkipsDividers() {
		let all = [
			message("2", "dev", .agent, "Second", at: 20),
			message("3", "ann", .human, "Joined", at: 15, system: true),
			message("1", "ann", .human, "First", at: 10),
		]
		let text = ChatMarkdownExport.markdown(title: "Pricing", messages: all, timeZone: TimeZone(identifier: "UTC")!)
		#expect(text.hasPrefix("# Pricing\n\n2 messages from 1 person and 1 agent"))
		#expect(text.range(of: "First")!.lowerBound < text.range(of: "Second")!.lowerBound)
		#expect(!text.contains("Joined"))
		#expect(text.contains("**Ann** · 1970-01-01 00:00"))
	}

	@Test func fileNameDropsPathCharacters() {
		#expect(ChatMarkdownExport.fileName(title: "a/b: c") == "a b  c.md")
		#expect(ChatMarkdownExport.fileName(title: "  ") == "Chat.md")
	}
}
