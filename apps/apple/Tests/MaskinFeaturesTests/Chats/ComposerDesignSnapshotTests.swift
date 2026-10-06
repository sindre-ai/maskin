import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#endif

@testable import MaskinFeatures

private struct StubUploader: ChatFileUploading {
	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		ChatAttachmentRef(fileID: UUID().uuidString, name: name, mimeType: mimeType, sizeBytes: data.count)
	}
}

private let me = ChatParticipant(id: "me", name: "Alex Preview", kind: .human)
private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
private let sam = ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)

@MainActor
private func composer(
	_ text: String = "", attach: [(String, String)] = [], formatting: Bool = false,
	voice: ComposerVoiceState = .idle
) async -> some View {
	UserDefaults.standard.set(formatting, forKey: "chat.formatting")
	let model = ChatComposerModel(uploader: StubUploader(), selfActorID: "me")
	model.text = text
	for (name, mime) in attach {
		model.attach(name: name, mimeType: mime) { PreparedChatFile(name: name, mimeType: mime, data: Data(count: 480_000)) }
	}
	// Let the stub uploads settle so the chips show their ready state.
	for _ in 0..<100 where model.isUploading { try? await Task.sleep(for: .milliseconds(10)) }
	return ChatComposer(
		model: model, placeholder: "Message Relay", suggestions: { _ in [relay, sam] },
		inConversation: ["relay"], onSend: {}, agentName: "Relay", showsVoiceControls: true, previewVoice: voice
	)
}

@MainActor
private func save<V: View>(
	_ view: V, name: String, dark: Bool, width: CGFloat = 402, height: CGFloat? = nil,
	canvas: Color = MaskinSurface.grouped
) throws {
	#if canImport(AppKit)
	// A hosting view draws the real controls (menus, scroll views, field text); ImageRenderer does not.
	let framed = view
		.padding(MaskinSpace.s7)
		.frame(width: width, height: height, alignment: .bottom)
		.background(canvas)
	let hosting = NSHostingView(rootView: framed)
	hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
	hosting.frame = NSRect(x: 0, y: 0, width: width, height: height ?? 10)
	hosting.layoutSubtreeIfNeeded()
	// Content can grow after its first layout (chips, wrapped text): settle, re-measure, settle.
	for _ in 0..<2 {
		hosting.frame = NSRect(x: 0, y: 0, width: width, height: height ?? hosting.fittingSize.height)
		hosting.layoutSubtreeIfNeeded()
		RunLoop.main.run(until: Date().addingTimeInterval(0.35))
	}
	hosting.layoutSubtreeIfNeeded()
	guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return }
	hosting.cacheDisplay(in: hosting.bounds, to: rep)
	let dir = ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] ?? NSTemporaryDirectory() + "composer-design"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
	try rep.representation(using: .png, properties: [:])?.write(to: url)
	#endif
}

/// A whole phone screen: the flat thread above the composer, as it will sit together.
@MainActor
private func screen(_ text: String = "", voice: ComposerVoiceState = .idle) async -> some View {
	func message(_ id: Int, _ who: ChatParticipant, _ text: String, minutes: Double) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: who.id, actorName: who.name, author: who.kind, content: text,
			createdAt: Date().addingTimeInterval(-minutes * 60))
	}
	let rows: [(ChatMessage, Bool)] = [
		(message(1, sam, "Can you pull together where the pipeline stands before Thursday?", minutes: 30), true),
		(message(2, relay, "Here is where the pipeline stands:\n\n- **3 bets** are blocked on legal review\n- **Forge** shipped the importer fix\n- Two insights need a decision from you\n\nWant me to draft the follow-ups?", minutes: 27), true),
		(message(3, me, "Yes please, and flag anything risky.", minutes: 8), true),
		(message(4, me, "Also loop in @Sam on the legal blockers", minutes: 8), false),
	]
	let bar = await composer(text, voice: voice)
	return VStack(spacing: 0) {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(MaskinColor.ink)
			Spacer()
			VStack(spacing: 0) {
				Text("Relay").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Text("Q4 pipeline review").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			Spacer()
			Image(systemName: "ellipsis").foregroundStyle(MaskinColor.ink)
		}
		.padding(.horizontal, MaskinSpace.s9).padding(.vertical, MaskinSpace.s7)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ForEach(rows, id: \.0.id) { row in
				MessageRow(
					message: row.0, isOwn: row.0.actorID == "me", showsAuthor: row.1, onRetrySend: {}, onDiscard: {},
					onRetryAgent: {}
				)
				.padding(.top, row.1 ? MaskinSpace.s4 : -MaskinSpace.s3)
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		Spacer(minLength: 0)
		bar
	}
}

/// Only the conversation, for comparing message looks: header, a few turns, a long agent answer.
@MainActor
private func messagesScreen(style: MessageStyle) -> some View {
	func message(_ id: Int, _ who: ChatParticipant, _ text: String, minutes: Double) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: who.id, actorName: who.name, author: who.kind, content: text,
			createdAt: Date().addingTimeInterval(-minutes * 60))
	}
	let answer = """
		## Pipeline status

		Three things moved since Friday. **Forge** shipped the importer fix and `pnpm test` is green.

		- **3 bets** are blocked on legal review
		- **Billing migration** is high risk
		- Two insights need a decision from you

		```swift
		let risky = bets.filter(\\.isHigh)
		```

		Want me to draft the follow-ups?
		"""
	let rows: [(ChatMessage, Bool)] = [
		(message(1, sam, "Can you pull together where the pipeline stands before Thursday?", minutes: 30), true),
		(message(2, relay, answer, minutes: 27), true),
		(message(3, me, "Yes please, and flag anything risky.", minutes: 8), true),
		(message(4, me, "Also loop in @Sam on the legal blockers", minutes: 8), false),
		(message(5, sam, "Thanks both, I'll review tonight.", minutes: 2), true),
	]
	return VStack(spacing: 0) {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(MaskinColor.ink)
			Spacer()
			VStack(spacing: 0) {
				Text("Relay").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Text("Q4 pipeline review").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			Spacer()
			Image(systemName: "ellipsis").foregroundStyle(MaskinColor.ink)
		}
		.padding(.horizontal, MaskinSpace.s9).padding(.vertical, MaskinSpace.s7)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ForEach(rows, id: \.0.id) { row in
				MessageRow(
					message: row.0, isOwn: row.0.actorID == "me", showsAuthor: row.1, onRetrySend: {}, onDiscard: {},
					onRetryAgent: {}
				)
				.padding(.top, row.1 ? MaskinSpace.s6 : -MaskinSpace.s3)
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.environment(\.messageStyle, style)
		Spacer(minLength: 0)
	}
}

@Suite("Message design variants", .enabled(if: ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] != nil, "design-review renders; set COMPOSER_DESIGN_DIR to run"))
@MainActor
struct MessageDesignSnapshotTests {
	@Test("message variants render", arguments: [false, true])
	func variants(dark: Bool) throws {
		let card = MaskinSurface.card
		// A: today's flat layout with crisper ink, a larger avatar and the time at the right edge.
		try save(
			messagesScreen(style: MessageStyle(avatar: MaskinSpace.s12, timeTrailing: true)), name: "m-a-crisp-flat",
			dark: dark, height: 874, canvas: card)
		// B: A, with your messages as a soft bubble on the right.
		try save(
			messagesScreen(style: MessageStyle(avatar: MaskinSpace.s12, timeTrailing: true, ownBubble: true)),
			name: "m-b-yours-bubble", dark: dark, height: 874, canvas: card)
		// C: agent answers as cards on the grey page, people flat.
		try save(
			messagesScreen(style: MessageStyle(avatar: MaskinSpace.s12, timeTrailing: true, ownBubble: true, agentCard: true)),
			name: "m-c-agent-cards", dark: dark, height: 874)
	}
}

@Suite("Composer design states", .enabled(if: ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] != nil, "design-review renders; set COMPOSER_DESIGN_DIR to run"))
@MainActor
struct ComposerDesignSnapshotTests {
	@Test("composer states render", arguments: [false, true])
	func states(dark: Bool) async throws {
		try save(await screen(), name: "s1-idle", dark: dark, height: 874)
		try save(await screen("Sounds good, send me the draft"), name: "s2-typing", dark: dark, height: 874)
		try save(await screen("Can you pull together the importer numbers", voice: .dictating), name: "s3-dictating", dark: dark, height: 874)
		try save(await screen("what changed since Friday and what is blocked", voice: .live(.listening)), name: "s4-live-listening", dark: dark, height: 874)
		try save(await screen("", voice: .live(.speaking)), name: "s5-live-speaking", dark: dark, height: 874)
		try save(await composer(), name: "1-empty", dark: dark)
		try save(await composer("Can you pull the importer numbers together?", formatting: true), name: "3-formatting", dark: dark)
		try save(await composer("Looping in @re"), name: "4-mention", dark: dark)
		try save(await composer("great work on that launch :tad"), name: "5-emoji", dark: dark)
		try save(
			await composer(
				"Here's the kickoff photo and the brief", attach: [("kickoff.jpg", "image/jpeg"), ("Launch brief.pdf", "application/pdf")]),
			name: "6-attachments", dark: dark)
	}
}
