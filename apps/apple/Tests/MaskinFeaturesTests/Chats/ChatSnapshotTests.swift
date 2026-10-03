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

private let me = ChatParticipant(id: "me", name: "Alex Preview", kind: .human)
private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
private let sam = ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)

private let base = Date()

private func message(
	_ id: Int, _ author: ChatParticipant, _ text: String, minutesAgo: Double,
	metadata: JSONValue? = nil
) -> ChatMessage {
	.confirmed(
		serverID: id, conversationID: "c1", actorID: author.id, actorName: author.name,
		author: author.kind, content: text, createdAt: base.addingTimeInterval(-minutesAgo * 60),
		metadata: metadata)
}

private actor FixtureAPI: ChatAPI {
	let rows: [ChatMessage]
	init(_ rows: [ChatMessage]) { self.rows = rows }
	func detail(conversationID: String) async throws -> ConversationSummary {
		ConversationSummary(id: "c1", title: "Q4 pipeline review", participants: [me, relay, sam])
	}
	func messages(conversationID: String, beforeID: Int?, afterID: Int?, limit: Int) async throws -> MessagePage {
		MessagePage(messages: rows, hasMore: false)
	}
	func send(conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String) async throws -> ChatMessage {
		try await Task.sleep(for: .seconds(60))
		throw ChatsError("offline")
	}
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws {}
	func markRead(conversationID: String, lastMessageID: Int) async throws {}
	func addParticipants(conversationID: String, actorIDs: [String]) async throws {}
	func actors() async throws -> [ChatActor] { [ChatActor(participant: relay, agentState: .running)] }
}

private let reply = """
	Here is where the pipeline stands:

	- **3 bets** are blocked on legal review
	- **Forge** shipped the importer fix
	- Two insights need a decision from you

	Want me to draft the follow-ups?
	"""

@MainActor
private func threadStore(streaming: Bool) async -> ChatStore {
	let failed = message(
		6, relay, "I couldn't finish that turn. The model API timed out.", minutesAgo: 1,
		metadata: .object(["final_output": .object(["is_error": .bool(true)])]))
	let rows = [
		message(1, sam, "Can someone pull together where the pipeline stands before Thursday?", minutesAgo: 60 * 26),
		message(2, me, "@Relay can you summarise?", minutesAgo: 60 * 26 - 1),
		message(3, relay, reply, minutesAgo: 60 * 26 - 3),
		message(4, me, "Yes please, and flag anything risky.", minutesAgo: 8),
		message(5, sam, "I'll check legal.", minutesAgo: 7),
	] + (streaming ? [] : [failed])
	let api = FixtureAPI(rows)
	let outbox = Outbox(
		fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString).json"),
		executor: ChatSendExecutor(api: api, onDelivered: { _, _ in }), network: ManualNetworkMonitor(isOnline: false),
		workspaceId: { "w1" })
	let store = ChatStore(
		conversationID: "c1", currentActorID: "me", currentActorName: me.name, api: api,
		queue: ChatSendQueue(outbox: outbox), events: nil, pollInterval: nil)
	await store.load()
	if streaming {
		// A message still on its way out, plus agents we are waiting on.
		store.send("Also loop in Sam on the legal blockers")
	}
	return store
}

@MainActor
private func render<V: View>(
	_ view: V, width: CGFloat, dark: Bool, name: String
) throws -> URL? {
	let framed = view
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return nil
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
	return url
}

@Suite("Chats snapshots")
@MainActor
struct ChatSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("thread with a streaming agent and an unsent message renders", arguments: [false, true])
	func thread(dark: Bool) async throws {
		let store = await threadStore(streaming: true)
		for width in Self.widths {
			let content = ThreadTranscript(store: store, lazy: false)
				.padding(MaskinSpace.s9)
			_ = try render(content, width: width, dark: dark, name: "thread-streaming")
		}
		#expect(store.workingAgents().map(\.id) == ["relay"])
	}

	@Test("thread with a failed agent reply offers Try again", arguments: [false, true])
	func failedReply(dark: Bool) async throws {
		let store = await threadStore(streaming: false)
		for width in Self.widths {
			_ = try render(ThreadTranscript(store: store, lazy: false).padding(MaskinSpace.s9), width: width, dark: dark, name: "thread-failed")
		}
		#expect(store.messages.last?.isErrorReply == true)
	}

	@Test("conversation list rows render grouped", arguments: [false, true])
	func list(dark: Bool) throws {
		let rows = [
			("Pinned", [ConversationSummary(id: "1", title: "Q4 pipeline review", lastMessageAt: base.addingTimeInterval(-300), pinned: true, unreadCount: 3, snippet: "Two insights need a decision from you", snippetActorName: "Relay", participants: [me, relay, sam])]),
			("Today", [
				ConversationSummary(id: "2", title: "Relay", lastMessageAt: base.addingTimeInterval(-3600), snippet: "Done. I merged the importer fix and re-ran the checks.", snippetActorName: "Relay", participants: [me, relay]),
				ConversationSummary(id: "3", title: "Sam Berg", lastMessageAt: base.addingTimeInterval(-7200), unreadCount: 1, snippet: "Sounds good, talk tomorrow", snippetActorName: "Sam Berg", participants: [me, sam]),
			]),
			("Earlier", [ConversationSummary(id: "4", title: "Onboarding flow", lastMessageAt: base.addingTimeInterval(-86400 * 20), snippet: "No messages yet", participants: [me, relay])]),
		]
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(rows, id: \.0) { label, items in
					MonoLabel(label)
					ForEach(items) { ConversationRow(conversation: $0, currentActorID: "me") }
				}
			}
			.padding(MaskinSpace.s9)
			_ = try render(view, width: width, dark: dark, name: "list")
		}
	}

	@Test("empty state renders", arguments: [false, true])
	func empty(dark: Bool) throws {
		for width in Self.widths {
			let view = EmptyState(symbol: "bubble.left.and.bubble.right", title: "No conversations yet", message: "Start one with a teammate or an agent.") {
				Button("New chat") {}.buttonStyle(.primaryAction)
			}
			.frame(height: 360)
			_ = try render(view, width: width, dark: dark, name: "empty")
		}
	}

	@Test("composer renders", arguments: [false, true])
	func composer(dark: Bool) throws {
		struct Host: View {
			@State var text = "Draft a follow-up for Sam"
			var body: some View { GlassComposer(text: $text, placeholder: "Message") {}.padding(MaskinSpace.s9) }
		}
		for width in Self.widths { _ = try render(Host(), width: width, dark: dark, name: "composer") }
	}
}
