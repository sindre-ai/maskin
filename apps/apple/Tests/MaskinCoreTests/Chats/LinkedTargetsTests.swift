import Foundation
import Testing

@testable import MaskinCore

@Suite("LinkedTargets")
struct LinkedTargetsTests {
	let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
	let one = "11111111-2222-3333-4444-555555555555"
	let two = "22222222-2222-3333-4444-555555555555"
	let file = "33333333-2222-3333-4444-555555555555"

	private func object(_ id: String) -> String { "https://maskin.io/\(ws)/objects/\(id)" }
	private func fileURL(_ id: String) -> String { "https://maskin.io/\(ws)/files/\(id)" }

	// MARK: Extraction

	@Test("extract scans a text once and answers repeat reads from the cache")
	func extractIsCached() {
		let text = "Draft: [Email](\(object(one)))"
		let cache = LinkScanCache<[LinkedTarget]>()
		let first = LinkedTarget.extract(from: text, cache: cache)
		for _ in 0..<20 { #expect(LinkedTarget.extract(from: text, cache: cache) == first) }
		#expect(first.map(\.key) == ["object:\(one)"])
		#expect(cache.computeCount == 1)
		_ = LinkedTarget.extract(from: "Another [Email](\(object(two)))", cache: cache)
		#expect(cache.computeCount == 2)
	}

	@Test("split scans a text once and answers repeat reads from the cache")
	func splitIsCached() {
		let text = "Draft:\n\n[Email](\(object(one)))\n\nmore"
		let cache = LinkScanCache<[LinkedSegment]>()
		let first = LinkedMessageSplitter.split(text, cache: cache)
		for _ in 0..<20 { #expect(LinkedMessageSplitter.split(text, cache: cache) == first) }
		#expect(first == LinkedMessageSplitter.scan(text))
		#expect(cache.computeCount == 1)
	}

	@Test("the public calls go through the shared cache")
	func publicCallsUseTheSharedCache() {
		// A text no other test uses, so the shared cache cannot already hold it.
		let text = "Draft: [Email](\(object(one))) \(UUID().uuidString)"
		#expect(LinkScanCaches.targets.peek(text) == nil)
		#expect(LinkedTarget.extract(from: text) == LinkedTarget.scan(text))
		#expect(LinkScanCaches.targets.peek(text) != nil)
		#expect(LinkScanCaches.segments.peek(text) == nil)
		#expect(LinkedMessageSplitter.split(text) == LinkedMessageSplitter.scan(text))
		#expect(LinkScanCaches.segments.peek(text) != nil)
	}

	@Test("finds objects and files in links of every shape, once each, in order")
	func extraction() {
		let text = """
			Draft: [Email to Torben](\(object(one))) and <\(fileURL(file))>, also \(object(two)).
			Again [the email](\(object(one.uppercased()))) and [relative](/\(ws)/objects/\(two)).
			"""
		let found = LinkedTarget.extract(from: text)
		#expect(found.map(\.key) == ["object:\(one)", "file:\(file)", "object:\(two)"])
	}

	@Test("an id in prose, a link elsewhere or an image is not a target")
	func notTargets() {
		#expect(LinkedTarget.extract(from: "The id is \(one) and see https://example.com/page").isEmpty)
		#expect(LinkedTarget.parse(href: "https://maskin.io/\(ws)/loops/\(one)")?.kind == .loop)
		#expect(LinkedTarget.parse(href: "maskin://\(ws)/files/\(file)")?.kind == .file)
	}

	@Test("a closing bracket and full stop after a bare address are the sentence's")
	func bareAddressPunctuation() {
		let found = LinkedTarget.extract(from: "(see \(object(one))).")
		#expect(found.map(\.uuid) == [one])
	}

	// MARK: Splitting

	@Test("a link that is a paragraph of its own is lifted out in place")
	func standaloneParagraph() {
		let text = "I wrote the email.\n\n[Email to Torben](\(object(one)))\n\nTell me if it looks right."
		let segments = LinkedMessageSplitter.split(text)
		#expect(
			segments == [
				.text("I wrote the email."),
				.item(LinkedTarget(kind: .object, uuid: one), label: nil, source: "[Email to Torben](\(object(one)))"),
				.text("Tell me if it looks right."),
			])
	}

	@Test("a bare address, bold, a short label and closing punctuation still count as alone")
	func standaloneVariants() {
		let variants = [
			object(one),
			"<\(object(one))>",
			"**[Draft](\(object(one)))**",
			"Draft: [Email](\(object(one)))",
			"Email to Torben: \(object(one))",
			"[Email](\(object(one))).",
			"[Email](\(object(one)))",
		]
		for variant in variants {
			let segments = LinkedMessageSplitter.split(variant)
			#expect(segments.count == 1, "\(variant)")
			guard case .item(let target, _, _)? = segments.first else {
				Issue.record("not lifted: \(variant)")
				continue
			}
			#expect(target.uuid == one)
		}
	}

	@Test("a link inside a sentence, or with a long or colon-less label, stays text")
	func notStandalone() {
		let variants = [
			"I put the email at [Email](\(object(one))) for you.",
			"Here it is [Email](\(object(one)))",
			"A really quite long introduction that goes on and on and on past sixty characters: \(object(one))",
			"[a](\(object(one))) and [b](\(object(two)))",
			"[Email](\(object(one))) and https://example.com",
			"`\(object(one))`",
			"![shot](\(object(one)))",
			"> [Email](\(object(one)))",
			"# [Email](\(object(one)))",
			"    \(object(one))",
		]
		for variant in variants {
			#expect(LinkedMessageSplitter.split(variant) == [.text(variant)], "\(variant)")
		}
	}

	@Test("list items are lifted one by one, and a label is not allowed there")
	func listItems() {
		let text = "Two drafts:\n- [First](\(object(one)))\n- Second: [Another](\(object(two)))\n- [Third](\(fileURL(file)))"
		let segments = LinkedMessageSplitter.split(text)
		#expect(
			segments == [
				.text("Two drafts:"),
				.item(LinkedTarget(kind: .object, uuid: one), label: nil, source: "- [First](\(object(one)))"),
				.text("- Second: [Another](\(object(two)))"),
				.item(LinkedTarget(kind: .file, uuid: file), label: nil, source: "- [Third](\(fileURL(file)))"),
			])
	}

	@Test("fenced code is never read for links")
	func fencedCode() {
		let text = "```\n\(object(one))\n```"
		#expect(LinkedMessageSplitter.split(text) == [.text(text)])
	}

	@Test("a message with no stand-alone link is one untouched text")
	func plainMessage() {
		let text = "Hello **there**\n\n- a\n- b"
		#expect(LinkedMessageSplitter.split(text) == [.text(text)])
		#expect(LinkedMessageSplitter.split("") == [])
	}

	// MARK: Layout

	@Test("a stand-alone link that is not a card stays in the text, merged back with its neighbours")
	func neverVanishes() {
		let text = "Before.\n\n[Email](\(object(one)))\n\nAfter."
		let segments = LinkedMessageSplitter.split(text)
		let parts = LinkedMessageLayout.parts(segments: segments, isCard: { _ in false })
		#expect(parts == [.markdown("Before.\n\n[Email](\(object(one)))\n\nAfter.")])
	}

	@Test("a card replaces its link in place and the text around it is kept")
	func cardInPlace() {
		let text = "Before.\n\n[Email](\(object(one)))\n\nAfter."
		let segments = LinkedMessageSplitter.split(text)
		let parts = LinkedMessageLayout.parts(segments: segments, isCard: { $0.uuid == one })
		#expect(parts == [.markdown("Before."), .card(LinkedTarget(kind: .object, uuid: one)), .markdown("After.")])
	}

	@Test("a target is drawn once in place; its second stand-alone mention stays a link")
	func drawnOnce() {
		let text = "[A](\(object(one)))\n\n[B](\(object(one)))"
		let parts = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(text), isCard: { _ in true })
		#expect(parts == [.card(LinkedTarget(kind: .object, uuid: one)), .markdown("[B](\(object(one)))")])
	}

	@Test("in-sentence cards go under the message, never twice, three cards in all")
	func appended() {
		let ids = (1...5).map { "0000000\($0)-2222-3333-4444-555555555555" }
		let sentence = ids.map { "see [x](\(object($0)))" }.joined(separator: ", ")
		let text = "[Placed](\(object(one)))\n\n\(sentence) and \(object(one)) and \(fileURL(file))"
		let parts = LinkedMessageLayout.parts(
			segments: LinkedMessageSplitter.split(text), isCard: { _ in true }, limit: LinkedMessageLayout.maxCardsPerMessage)
		let under = LinkedMessageLayout.appended(message: text, parts: parts, isCard: { _ in true })
		// One card is placed, so two more fit, whatever their kind.
		#expect(under.map(\.uuid) == [ids[0], ids[1]])
		#expect(!under.contains { $0.uuid == one })
	}

	@Test("the three cards are shared by every kind, in the order the message links them")
	func capAcrossKinds() {
		let ids = (1...4).map { "0000000\($0)-2222-3333-4444-555555555555" }
		let text = "see \(fileURL(file)) and \(object(ids[0])) and \(object(ids[1])) and \(object(ids[2]))"
		let under = LinkedMessageLayout.appended(message: text, parts: [], isCard: { _ in true })
		#expect(under.map(\.uuid) == [file, ids[0], ids[1]])
	}

	@Test("stand-alone links past the cap stay links in the text")
	func capInPlace() {
		let ids = (1...4).map { "0000000\($0)-2222-3333-4444-555555555555" }
		let text = ids.map { "[x](\(object($0)))" }.joined(separator: "\n\n")
		let parts = LinkedMessageLayout.parts(
			segments: LinkedMessageSplitter.split(text), isCard: { _ in true }, limit: LinkedMessageLayout.maxCardsPerMessage)
		#expect(
			parts == [
				.card(LinkedTarget(kind: .object, uuid: ids[0])), .card(LinkedTarget(kind: .object, uuid: ids[1])),
				.card(LinkedTarget(kind: .object, uuid: ids[2])), .markdown("[x](\(object(ids[3])))"),
			])
		#expect(LinkedMessageLayout.appended(message: text, parts: parts, isCard: { _ in true }).isEmpty)
	}

	@Test("a target that is a card in an earlier message stays a link here")
	func skippedTargets() {
		let text = "[A](\(object(one)))\n\nsee [b](\(object(two)))"
		let skipping: Set<String> = [LinkedTarget(kind: .object, uuid: one).key]
		let parts = LinkedMessageLayout.parts(
			segments: LinkedMessageSplitter.split(text), isCard: { _ in true }, skipping: skipping)
		#expect(parts == [.markdown(text)])
		let under = LinkedMessageLayout.appended(message: text, parts: parts, isCard: { _ in true }, skipping: skipping)
		#expect(under.map(\.uuid) == [two])
	}

	@Test("at most ten objects are looked up in a message, the rest stay plain")
	func lookupCap() {
		let objects = (1...12).map { LinkedTarget(kind: .object, uuid: String(format: "%08d-2222-3333-4444-555555555555", $0)) }
		let files = (1...2).map { LinkedTarget(kind: .file, uuid: String(format: "%08d-3333-3333-4444-555555555555", $0)) }
		let looked = LinkedMessageLayout.lookupTargets(objects + files)
		#expect(looked.filter { $0.kind == .object } == Array(objects.prefix(10)))
		#expect(looked.filter { $0.kind == .file } == files)
	}

	@Test("agent and chat addresses are targets, and count with objects toward the ten lookups")
	func agentAndChatTargets() {
		let agent = LinkedTarget.parse(href: "https://maskin.io/\(ws)/agents/\(one)")
		let chat = LinkedTarget.parse(href: "https://maskin.io/\(ws)/chats/\(two)?thread=4")
		#expect(agent == LinkedTarget(kind: .agent, uuid: one))
		#expect(chat == LinkedTarget(kind: .chat, uuid: two))
		#expect(agent?.key == "agent:\(one)" && chat?.key == "chat:\(two)")
		// The agents list (no id) is not a target.
		#expect(LinkedTarget.parse(href: "https://maskin.io/\(ws)/agents") == nil)
		let objects = (1...8).map { LinkedTarget(kind: .object, uuid: String(format: "%08d-2222-3333-4444-555555555555", $0)) }
		let more = [LinkedTarget(kind: .agent, uuid: one), LinkedTarget(kind: .chat, uuid: two), LinkedTarget(kind: .agent, uuid: file)]
		#expect(LinkedMessageLayout.lookupTargets(objects + more) == Array((objects + more).prefix(10)))
		#expect(LinkedConversationItems.mayLink("see \(chat!.key) /chats/") && !LinkedConversationItems.mayLink("no links"))
	}

	@Test("only targets that are cards are appended")
	func appendedOnlyCards() {
		let text = "see [x](\(object(one))) and [y](\(object(two)))"
		let under = LinkedMessageLayout.appended(message: text, parts: [], isCard: { $0.uuid == two })
		#expect(under.map(\.uuid) == [two])
	}

	// MARK: The conversation's linked items

	private func message(_ id: Int, _ content: String, actor: String = "agent-1", kind: String = "message") -> ChatMessage {
		ChatMessage(
			id: "m\(id)", serverID: id, conversationID: "c", actorID: actor, actorName: "Relay", author: .agent,
			kind: kind, content: content, createdAt: Date(timeIntervalSince1970: TimeInterval(id)))
	}

	@Test("the drawer lists each target once, newest linking message first")
	func derive() {
		let entries = LinkedConversationItems.derive(from: [
			message(1, "[a](\(object(one))) [f](\(fileURL(file)))"),
			message(2, "nothing here"),
			message(3, "[again](\(object(one))) and [b](\(object(two)))", actor: "agent-2"),
			message(4, "system line \(object(two))", kind: "system"),
		])
		#expect(entries.map(\.target.uuid) == [one, two, file])
		#expect(entries[0].messageID == "m3")
		#expect(entries[0].actorID == "agent-2")
		#expect(entries[2].messageID == "m1")
	}

	@Test("a target belongs to the first message that links it")
	func firstMentions() {
		let owners = LinkedConversationItems.firstMentions(in: [
			message(1, "nothing here"),
			message(2, "[a](\(object(one))) and [f](\(fileURL(file)))"),
			message(3, "[again](\(object(one))) and [b](\(object(two)))"),
			message(4, "system line \(object(two))", kind: "system"),
		])
		#expect(owners[LinkedTarget(kind: .object, uuid: one).key] == "m2")
		#expect(owners[LinkedTarget(kind: .object, uuid: two).key] == "m3")
		#expect(owners[LinkedTarget(kind: .file, uuid: file).key] == "m2")
	}

	@Test("the drawer stops at its limit")
	func deriveLimit() {
		let entries = LinkedConversationItems.derive(
			from: [message(1, "\(object(one)) \(object(two)) \(fileURL(file))")], limit: 2)
		#expect(entries.count == 2)
	}

	// MARK: Code, labels, identity

	@Test("a link quoted as code is not a link: no card, nothing in the drawer")
	func codeIsNotALink() {
		let fenced = "Example:\n```\n\(object(one))\n```"
		let inline = "Use `\(object(one))` as the address"
		for text in [fenced, inline] {
			#expect(LinkedTarget.extract(from: text).isEmpty, "\(text)")
			#expect(LinkedMessageLayout.appended(message: text, parts: [], isCard: { _ in true }).isEmpty)
			#expect(LinkedConversationItems.derive(from: [message(1, text)]).isEmpty)
		}
		#expect(LinkedTarget.extract(from: "`x` and [real](\(object(two)))").map(\.uuid) == [two])
	}

	@Test("a lead-in before a lone link stays words when the card replaces the link")
	func labelStays() {
		let text = "Approve this one, it supersedes the earlier:\n\(object(one))\n\nOr: \(object(two))"
		let parts = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(text), isCard: { _ in true })
		#expect(
			parts == [
				.markdown("Approve this one, it supersedes the earlier:"),
				.card(LinkedTarget(kind: .object, uuid: one)),
				.markdown("Or:"),
				.card(LinkedTarget(kind: .object, uuid: two)),
			])
		// Without the card the whole original paragraph is still there.
		let plain = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(text), isCard: { _ in false })
		#expect(plain == [.markdown(text)])
	}

	@Test("a card keeps its identity when text or other cards change above it")
	func stableIDs() {
		let a = LinkedMessagePart.card(LinkedTarget(kind: .object, uuid: one))
		#expect(a.stableID(at: 1) == a.stableID(at: 3))
		#expect(LinkedMessagePart.markdown("x").stableID(at: 0) != LinkedMessagePart.markdown("x").stableID(at: 2))
	}

	@Test("a ~~~ line inside a ``` block does not close it")
	func mixedFences() {
		let text = "```\n~~~\n\(object(one))\n```"
		#expect(LinkedMessageSplitter.split(text) == [.text(text)])
		#expect(LinkedTarget.extract(from: text).isEmpty)
	}

	@Test("an indented line is code unless it continues a list; a reference definition is not a card")
	func indentedAndDefinitions() {
		let code = "    - \(object(one))"
		#expect(LinkedMessageSplitter.split(code) == [.text(code)])
		let nested = "- list\n    - \(object(one))"
		#expect(LinkedMessageSplitter.split(nested).contains { if case .item = $0 { true } else { false } })
		let definition = "[1]: \(object(one))"
		#expect(LinkedMessageSplitter.split(definition) == [.text(definition)])
	}

	@Test("a tight list stays tight when a card elsewhere resolves")
	func tightList() {
		let text = "- a\n- b\n\n[Email](\(object(one)))"
		let parts = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(text), isCard: { _ in true })
		#expect(parts == [.markdown("- a\n- b"), .card(LinkedTarget(kind: .object, uuid: one))])
		let around = "- a\n- [x](\(object(one)))\n- c"
		let split = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(around), isCard: { _ in true })
		#expect(split == [.markdown("- a"), .card(LinkedTarget(kind: .object, uuid: one)), .markdown("- c")])
		let plain = LinkedMessageLayout.parts(segments: LinkedMessageSplitter.split(around), isCard: { _ in false })
		#expect(plain == [.markdown(around)])
	}
}
