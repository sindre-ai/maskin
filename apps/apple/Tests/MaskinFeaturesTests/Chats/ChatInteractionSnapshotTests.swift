import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

@MainActor
private func eventually(_ condition: @MainActor () -> Bool) async -> Bool {
	var budget = PollBudget()
	repeat {
		if condition() { return true }
		try? await Task.sleep(for: .milliseconds(10))
	} while budget.spend()
	return condition()
}

private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
private let sam = ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)
private let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)

private actor ScriptedUploader: ChatFileUploading {
	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		if name.hasPrefix("slow") {
			try await Task.sleep(for: .seconds(3600))
		}
		if name.hasPrefix("bad") { throw ChatsError("Over the 10 MB limit.") }
		return ChatAttachmentRef(fileID: "f-\(name)", name: name, mimeType: mimeType, sizeBytes: data.count)
	}
}

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.padding(MaskinSpace.s9)
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	let dir =
		ProcessInfo.processInfo.environment["CHATS_SNAPSHOT_DIR"]
		?? NSTemporaryDirectory() + "chats-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

private let questionMetadata: JSONValue = .object([
	"question": .object([
		"session_id": .string("s1"),
		"questions": .array([
			.object([
				"question": .string("Which environment should I deploy to?"), "header": .string("Environment"),
				"multi_select": .bool(false),
				"options": .array([
					.object(["label": .string("Staging")]),
					.object(["label": .string("Production"), "description": .string("Live users")]),
					.object(["label": .string("Both, staging first")]),
				]),
			]),
			.object([
				"question": .string("What should I include in the summary?"), "header": .string("Summary"),
				"multi_select": .bool(true),
				"options": .array([
					.object(["label": .string("Changelog")]), .object(["label": .string("Risks")]),
					.object(["label": .string("Rollback plan")]),
				]),
			]),
		]),
	])
])

private func agentMessage(_ text: String, metadata: JSONValue? = nil) -> ChatMessage {
	.confirmed(
		serverID: 7, conversationID: "c1", actorID: "relay", actorName: "Relay", author: .agent, content: text,
		createdAt: Date(), metadata: metadata)
}

private func ownMessage(_ text: String, status: ChatMessage.Status, metadata: JSONValue? = nil) -> ChatMessage {
	ChatMessage(
		id: "local-1", conversationID: "c1", actorID: "me", actorName: "Me", author: .human, content: text,
		createdAt: Date(), metadata: metadata, status: status)
}

@Suite("Chat interaction snapshots")
@MainActor
struct ChatInteractionSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("an agent's question renders as options, and answered as a summary", arguments: [false, true])
	func questions(dark: Bool) throws {
		let message = agentMessage("Before I deploy I need two answers.", metadata: questionMetadata)
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				MessageRow(message: message, isOwn: false, showsAuthor: true)
				MessageRow(
					message: message, isOwn: false, showsAuthor: false,
					questionAnswers: [
						.init(header: "Environment", selected: ["Production"]),
						.init(header: "Summary", selected: ["Changelog", "Risks"]),
					])
			}
			try render(view, width: width, dark: dark, name: "question")
		}
		#expect(message.questions.count == 2)
		#expect(message.questions[1].multiSelect)
	}

	@Test("queued, sending and failed messages are distinguishable", arguments: [false, true])
	func sendStates(dark: Bool) throws {
		let files = ChatSendMetadata(
			attachments: [ChatAttachmentRef(fileID: "f", name: "Q4-pipeline.pdf", mimeType: "application/pdf", sizeBytes: 482_000)],
			mentions: ["relay"]).jsonValue
		for width in Self.widths {
			let view = VStack(alignment: .trailing, spacing: MaskinSpace.s7) {
				MessageRow(
					message: ownMessage("Sending right now", status: .sending), isOwn: true, showsAuthor: false,
					sendStatus: .sending)
				MessageRow(
					message: ownMessage("Typed on the plane", status: .waiting("Waiting for a connection"), metadata: files),
					isOwn: true, showsAuthor: false, mentionNames: ["Relay"], sendStatus: .notSent)
				MessageRow(
					message: ownMessage("This one was refused by the server", status: .failed("This conversation no longer exists.")),
					isOwn: true, showsAuthor: false, sendStatus: .notSent)
				MessageRow(message: ownMessage("Landed and read", status: .sent), isOwn: true, showsAuthor: false, sendStatus: .read(by: "Relay"))
			}
			try render(view, width: width, dark: dark, name: "send-states")
		}
	}

	@Test("the composer shows attachment and mention chips in every state", arguments: [false, true])
	func composerChips(dark: Bool) async throws {
		let model = ChatComposerModel(uploader: ScriptedUploader(), selfActorID: "me")
		model.text = "Here is the data, can you check it?"
		func file(_ name: String) -> @Sendable () async throws -> PreparedChatFile {
			{ PreparedChatFile(name: name, mimeType: name.hasSuffix(".png") ? "image/png" : "application/pdf", data: Data(count: 4_200)) }
		}
		model.attach(name: "ok.png", mimeType: "image/png", prepare: file("ok.png"))
		model.attach(name: "bad.pdf", mimeType: "application/pdf", prepare: file("bad.pdf"))
		model.attach(name: "slow-report-with-a-very-long-name.pdf", mimeType: "application/pdf", prepare: file("slow-report-with-a-very-long-name.pdf"))
		model.addMention(ChatMention(id: "relay", name: "Relay", kind: .agent))
		model.addMention(ChatMention(id: "sam", name: "Sam Berg", kind: .human))
		#expect(await eventually { model.attachments.filter { $0.state != .uploading }.count == 2 })
		for width in Self.widths {
			let view = ChatComposer(
				model: model, placeholder: "Message Q4 pipeline review", suggestions: { _ in [] },
				inConversation: [], onSend: {})
			try render(view, width: width, dark: dark, name: "composer-chips")
		}
		#expect(!model.canSend, "an uploading or failed attachment blocks Send")
		model.clear()
	}

	@Test("the @ picker lists this conversation first", arguments: [false, true])
	func mentionPicker(dark: Bool) throws {
		for width in Self.widths {
			let view = MentionSuggestions(
				candidates: [relay, sam, forge], inConversation: ["relay", "sam"], onPick: { _ in })
			try render(view, width: width, dark: dark, name: "mention-picker")
		}
		for width in Self.widths {
			try render(
				MentionSuggestions(candidates: [], inConversation: [], onPick: { _ in }), width: width, dark: dark,
				name: "mention-picker-empty")
		}
	}

	@Test("working indicator, typing bubble, streaming and stopped replies, and the resume banner", arguments: [false, true])
	func agentActivity(dark: Bool) throws {
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				TypingBubble(agent: relay)
				TypingBubble(agent: forge)
				WorkingIndicator(agent: relay, activity: "Reading the Q4 pipeline brief")
				WorkingIndicator(agent: forge)
				TypingIndicator(agent: relay)
				StreamingReplyBubble(agent: forge, text: "Three things moved since Friday. The importer")
				StreamingReplyBubble(agent: forge, text: "I was halfway through the", stopped: true)
				StreamingReplyBubble(agent: relay, stopped: true)
				ResumeBanner(agent: forge, onResume: {})
			}
			try render(view, width: width, dark: dark, name: "agent-activity")
		}
	}

	@Test("the nav title variants: direct quiet, live, group, flow", arguments: [false, true])
	func navTitle(dark: Bool) throws {
		let flow = ChatFlowContext(loopID: "l1", name: "Q4 launch", leadID: "relay", memberIDs: ["relay", "forge", "sam"])
		for width in Self.widths {
			let view = VStack(spacing: MaskinSpace.s7) {
				ThreadNavTitle(title: "Relay")
				ThreadNavTitle(title: "Relay", status: .live("working"))
				ThreadNavTitle(title: "Relay, Sam Berg, Forge", status: .live("working"))
				HStack {
					ThreadNavTitle(title: "Q4 launch", status: .quiet("Q4 launch flow"), onTap: {})
					ThreadNavAvatars(participants: [relay, forge, sam], leadID: "relay", limit: 3)
				}
				ThreadNavAvatars(participants: [relay, forge, sam, relay], limit: 4)
			}
			try render(view, width: width, dark: dark, name: "nav-title")
		}
		#expect(ThreadNav.title(participants: [relay, sam], currentActorID: "me", fallback: "Chat", flow: nil) == "Relay, Sam Berg")
		#expect(ThreadNav.title(participants: [relay], currentActorID: "me", fallback: "Chat", flow: nil) == "Relay")
		#expect(ThreadNav.title(participants: [], currentActorID: "me", fallback: "Chat", flow: flow) == "Q4 launch")
		#expect(ThreadNav.status(presences: [], flow: nil) == nil)
		#expect(ThreadNav.status(presences: [(relay, .working)], flow: nil) == .live("working"))
		#expect(ThreadNav.status(presences: [(relay, .working), (forge, .typing)], flow: nil) == .live("working"))
		#expect(ThreadNav.status(presences: [], flow: flow) == .quiet("Q4 launch flow"))
		#expect(ThreadNav.status(presences: [(relay, .typing)], flow: flow) == .live("working"))
		#expect(ThreadNav.status(presences: [(relay, .working), (forge, .working)], flow: flow) == .live("2 working"))
		#expect(!ThreadNav.showsMemberStack(participants: [relay, sam], flow: nil))
		#expect(ThreadNav.showsMemberStack(participants: [relay, sam, forge], flow: nil))
	}

	@Test("jump-to-latest, pinned strip, quick replies and the search bar render", arguments: [false, true])
	func chrome(dark: Bool) throws {
		let pinned = agentMessage("Decision: we ship the importer fix on Thursday, legal has signed off on the addendum.")
		for width in Self.widths {
			struct SearchHost: View {
				@State var text = "importer"
				var body: some View {
					ThreadSearchBar(text: $text, matchCount: 5, index: 1, onStep: { _ in }, onClose: {})
				}
			}
			let view = VStack(alignment: .trailing, spacing: MaskinSpace.s7) {
				JumpToLatest(unseen: 0) {}
				JumpToLatest(unseen: 3) {}
				PinnedMessageStrip(message: pinned, onOpen: {}, onUnpin: {})
				QuickReplyChips(replies: QuickReplyRules.replies(for: .permission), onPick: { _ in })
				SearchHost()
			}
			try render(view, width: width, dark: dark, name: "thread-chrome")
		}
		#expect(JumpToLatest.accessibilityLabel(unseen: 3) == "Jump to latest, 3 new messages")
		#expect(SwipeToReply.offset(for: 40) == 28)
		#expect(SwipeToReply.offset(for: 200) == SwipeToReply.cap)
		#expect(SwipeToReply.offset(for: -30) == 0)
	}
}
