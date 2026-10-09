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
	let lastRead: Int?
	init(_ rows: [ChatMessage], lastRead: Int? = nil) {
		self.rows = rows
		self.lastRead = lastRead
	}
	func detail(conversationID: String) async throws -> ConversationSummary {
		ConversationSummary(
			id: "c1", title: "Q4 pipeline review", participants: [me, relay, sam], lastReadMessageID: lastRead)
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

// No table here: `ImageRenderer` draws no scroll views, and a table is one. Tables are covered by
// the parser tests, and checked rendered through `NSHostingView` (which does draw them).
private let richReply = """
	## Pipeline status

	Three things moved since Friday. **Forge** shipped the importer fix and `pnpm test` is green.

	### Next steps
	- [x] Merge the importer fix
	- [ ] Ask legal about the data processing addendum
	- [ ] Draft the customer note

	```swift
	let risky = bets.high
	print(risky.count)
	```

	See [the report](https://maskin.io/report) for detail.
	"""

/// A stand-in photo: a diagonal blue-to-violet gradient, so scaling and cropping are visible.
private let samplePhoto: DecodedImage = {
	let width = 600, height = 400
	let context = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	let colors = [CGColor(red: 0.18, green: 0.45, blue: 0.95, alpha: 1), CGColor(red: 0.62, green: 0.22, blue: 0.85, alpha: 1)]
	let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
	context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
	return DecodedImage(context.makeImage()!)
}()

@MainActor
private func richStore() async -> ChatStore {
	var edited4 = message(4, me, "Send it to legal too: https://maskin.io/report", minutesAgo: 6)
	edited4.editedAt = base
	var edited6 = message(6, sam, "line one\nline two\nline three", minutesAgo: 4)
	edited6.editedAt = base
	let rows = [
		message(1, sam, "Can you give me the status?", minutesAgo: 20),
		message(2, relay, richReply, minutesAgo: 18),
		message(3, me, "Thanks, that's clear.", minutesAgo: 6),
		edited4,
		message(5, me, "And ping Sam", minutesAgo: 5),
		edited6,
		message(7, me, "👍", minutesAgo: 3),
		message(8, relay, "[Launch video campaign](https://maskin.io/ws1/objects/obj1)", minutesAgo: 2),
		message(
			9, relay,
			"Blocked by https://maskin.io/ws1/objects/obj2 and tracked in [the launch plan](https://maskin.io/ws1/objects/obj1), see [the docs](https://example.com).",
			minutesAgo: 2),
		message(10, me, "https://maskin.io/ws1/objects/obj1", minutesAgo: 1),
		message(
			11, sam, "Here's the kickoff photo and the brief.", minutesAgo: 1,
			metadata: ChatSendMetadata(attachments: [
				ChatAttachmentRef(fileID: "p1", name: "kickoff.jpg", mimeType: "image/jpeg", sizeBytes: 2_400_000),
				ChatAttachmentRef(fileID: "d1", name: "Launch brief.pdf", mimeType: "application/pdf", sizeBytes: 380_000),
			]).jsonValue),
		message(
			12, me, "Three from the site visit", minutesAgo: 0,
			metadata: ChatSendMetadata(attachments: [
				ChatAttachmentRef(fileID: "p2", name: "a.jpg", mimeType: "image/jpeg", sizeBytes: 900_000),
				ChatAttachmentRef(fileID: "p3", name: "b.jpg", mimeType: "image/jpeg", sizeBytes: 900_000),
				ChatAttachmentRef(fileID: "p4", name: "c.jpg", mimeType: "image/jpeg", sizeBytes: 900_000),
			]).jsonValue),
	]
	// Read up to Relay's reply: Sam's later message is "new".
	let api = FixtureAPI(rows, lastRead: 2)
	let outbox = Outbox(
		fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString).json"),
		executor: ChatSendExecutor(api: api, onDelivered: { _, _ in }), network: ManualNetworkMonitor(isOnline: false),
		workspaceId: { "w1" })
	let store = ChatStore(
		conversationID: "c1", currentActorID: "me", currentActorName: me.name, api: api,
		queue: ChatSendQueue(outbox: outbox), events: nil, pollInterval: nil)
	await store.load()
	return store
}

@MainActor
private func threadStore(streaming: Bool) async -> ChatStore {
	let failed = message(
		9, relay, "I couldn't finish that turn. The model API timed out.", minutesAgo: 1,
		metadata: .object(["final_output": .object(["is_error": .bool(true)])]))
	let rows = [
		message(1, sam, "Can someone pull together where the pipeline stands before Thursday?", minutesAgo: 60 * 26),
		message(2, me, "@Relay can you summarise?", minutesAgo: 60 * 26 - 1),
		message(3, relay, reply, minutesAgo: 60 * 26 - 3),
		message(4, me, "Yes please, and flag anything risky.", minutesAgo: 8),
		message(5, sam, "I'll check legal.", minutesAgo: 7),
		message(7, sam, "Heads up: legal usually needs two working days for anything touching the data processing addendum, so if the importer change counts we should tell the customer today.", minutesAgo: 6),
		message(8, me, "Understood. Let's tell them today and keep the launch date, but only if Relay confirms the importer change is contained to the staging tenant and nothing touches production data.", minutesAgo: 5),
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
	_ view: V, width: CGFloat, dark: Bool, name: String, canvas: Color = MaskinSurface.grouped
) throws -> URL? {
	let framed = view
		.frame(width: width)
		.background(canvas)
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
			_ = try render(content, width: width, dark: dark, name: "thread-streaming", canvas: MaskinSurface.card)
		}
		#expect(store.workingAgents().map(\.id) == ["relay"])
	}

	@Test("thread with a failed agent reply offers Try again", arguments: [false, true])
	func failedReply(dark: Bool) async throws {
		let store = await threadStore(streaming: false)
		for width in Self.widths {
			_ = try render(ThreadTranscript(store: store, lazy: false).padding(MaskinSpace.s9), width: width, dark: dark, name: "thread-failed", canvas: MaskinSurface.card)
		}
		#expect(store.messages.last?.isErrorReply == true)
	}

	@Test("rich agent reply and own message runs render", arguments: [false, true])
	func rich(dark: Bool) async throws {
		let store = await richStore()
		for width in Self.widths {
			// Ample height: `ImageRenderer` sizes a tall transcript before its text wraps and then squeezes
						// paragraphs to one line. The app lays this out in a scroll view with no height limit.
						let content = ThreadTranscript(store: store, lazy: false).padding(MaskinSpace.s9)
							.environment(\.attachmentImages, AttachmentImages(cached: { _ in samplePhoto }, load: { _ in samplePhoto }))
							.environment(\.markdownInternalLinkInfo, { url in
								guard let link = DeepLink(url: url), case .object(_, let id) = link else { return nil }
								// obj1 has been looked up; obj2 has not, so it shows its kind only.
								return id == "obj1"
									? MarkdownLinkInfo(symbol: "scope", kindLabel: "Bet", title: "Launch video campaign")
									: MarkdownLinkInfo(symbol: "checkmark.square", kindLabel: "Task")
							})
							.frame(height: 3200, alignment: .top)
						_ = try render(content, width: width, dark: dark, name: "thread-rich", canvas: MaskinSurface.card)
		}
		#expect(store.messages.count == 12)
	}

	@Test("the thread skeleton renders", arguments: [false, true])
	func skeleton(dark: Bool) throws {
		for width in Self.widths {
			_ = try render(ThreadSkeleton().frame(height: 560), width: width, dark: dark, name: "thread-skeleton", canvas: MaskinSurface.card)
		}
	}

	@Test("conversation list renders pinned tiles and inset day groups", arguments: [false, true])
	func list(dark: Bool) throws {
		let pinned = [
			ConversationSummary(id: "1", title: "Q4 pipeline review", lastMessageAt: base.addingTimeInterval(-300), pinned: true, unreadCount: 3, snippet: "Two insights need a decision from you", snippetActorName: "Relay", participants: [me, relay, sam]),
			ConversationSummary(id: "5", title: "Weekly brief for the board, draft two", lastMessageAt: base.addingTimeInterval(-900), pinned: true, snippet: "Draft is up", snippetActorName: "Relay", participants: [me, relay]),
			ConversationSummary(id: "6", title: "Hiring plan", lastMessageAt: base.addingTimeInterval(-2000), pinned: true, snippet: "Ok", snippetActorName: "Sam Berg", participants: [me, sam]),
		]
		let rows = [
			("Today", [
				ConversationSummary(id: "2", title: "Importer fix: can you confirm it is contained to the staging tenant before we tell the customer", lastMessageAt: base.addingTimeInterval(-3600), unreadCount: 2, snippet: "Done. I merged the importer fix and re-ran the checks, everything is green on the staging tenant.", snippetActorName: "Relay", participants: [me, relay]),
				ConversationSummary(id: "3", title: "Sam Berg", lastMessageAt: base.addingTimeInterval(-7200), snippet: "Sounds good, talk tomorrow", snippetActorName: "Sam Berg", participants: [me, sam]),
			]),
			("Yesterday", [ConversationSummary(id: "7", title: "Launch checklist", lastMessageAt: base.addingTimeInterval(-86400), snippet: "Added the legal step", snippetActorName: "Relay", participants: [me, relay, sam])]),
			("Last week", [ConversationSummary(id: "4", title: "Onboarding flow", lastMessageAt: base.addingTimeInterval(-86400 * 10), snippet: "No messages yet", participants: [me, relay])]),
		]
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				PinnedTiles(conversations: pinned, currentActorID: "me", selection: .constant(nil), onUnpin: { _ in })
				ForEach(rows, id: \.0) { label, items in
					MonoLabel(label)
					VStack(spacing: 0) {
						ForEach(items) {
							ConversationRow(conversation: $0, currentActorID: "me", now: base)
								.padding(.horizontal, MaskinSpace.s9).padding(.vertical, MaskinSpace.s4)
							Divider().overlay(MaskinSurface.separator)
						}
					}
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.card, style: .continuous))
				}
			}
			.padding(MaskinSpace.s9)
			_ = try render(view, width: width, dark: dark, name: "list")
		}
	}

	@Test("handoff rows, the group pill and activity render", arguments: [false, true])
	func handoffAndPeople(dark: Bool) throws {
		let handoff = SpawnedSession(
			id: "s2", status: "running", actorID: "relay", actorName: "Relay",
			actionPrompt: "Draft the importer rollout note for the customer\nKeep it short.",
			startedAt: base, currentActivity: "Reading notes/importer.md", dependsOn: ["s1"])
		let steps = [
			ActivityStep(id: "1", kind: .thinking, label: "Thinking"),
			ActivityStep(id: "2", kind: .toolUse, label: "Using Read", detail: "notes/importer.md"),
			ActivityStep(id: "3", kind: .text, label: "Writing the note", status: .running),
		]
		let turn = ActivityTurn(sessionID: "s2", messageID: 2, startedAt: base, status: .running, steps: steps)
		var done = handoff
		done.status = "completed"
		done.durationMs = 185_000
		done.currentActivity = nil
		done.outcomeText = "Note drafted and saved to the importer doc."
		var failed = handoff
		failed.status = "failed"
		failed.outcomeText = "Credit balance too low"
		var queued = handoff
		queued.status = "pending"
		for width in Self.widths {
			let view = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				GroupHeaderPill(participants: [me, relay, sam, ChatParticipant(id: "cpo", name: "CPO", kind: .agent), ChatParticipant(id: "dev", name: "Dev", kind: .agent)], selfID: "me", action: {})
				HandoffRow(session: queued, behind: ["Sentinel", "Forge"])
				HandoffRow(session: handoff)
				HandoffRow(session: done)
				HandoffRow(session: failed)
				LiveActivityView(agent: relay, turn: turn, startedAt: base.addingTimeInterval(-42), onStop: {})
				FinishedTraceView(turn: ActivityTurn(sessionID: "s3", messageID: 3, status: .failed, result: ActivityResult(text: "x", isError: true), steps: [ActivityStep(id: "9", kind: .error, label: "Credit balance too low", status: .failed)]))
			}
			.padding(MaskinSpace.s9)
			_ = try render(view, width: width, dark: dark, name: "handoff")
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
