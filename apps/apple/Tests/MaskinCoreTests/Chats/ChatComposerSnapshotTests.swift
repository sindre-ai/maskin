import Foundation
import Testing

@testable import MaskinCore

@Suite("ChatComposerModel snapshot")
@MainActor
struct ChatComposerSnapshotTests {
	private func model() -> ChatComposerModel { ChatComposerModel(uploader: nil, selfActorID: "me") }

	@Test("restore puts the text, mentions and reply quote back after a take")
	func restoresAfterTake() {
		let m = model()
		m.text = "hello there"
		m.addMention(ChatMention(id: "a1", name: "Forge", kind: .agent))
		m.beginReply(author: "Forge", content: "earlier", serverID: 7)
		let snapshot = m.snapshot()
		#expect(m.take() != nil)
		#expect(m.text.isEmpty)
		#expect(m.mentions.isEmpty)

		m.restore(snapshot)
		#expect(m.text == "hello there")
		#expect(m.mentions.map(\.id) == ["a1"])
		#expect(m.quote?.kind == .reply)
	}

	@Test("text typed while the message was held stays, after the restored text")
	func keepsNewText() {
		let m = model()
		m.text = "first"
		let snapshot = m.snapshot()
		_ = m.take()
		m.text = "second"
		m.restore(snapshot)
		#expect(m.text == "first\nsecond")
	}
}
