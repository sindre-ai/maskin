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
	voice: ComposerVoiceState = .idle, placeholder: String = "Message Relay"
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
		model: model, placeholder: placeholder, suggestions: { _ in [relay, sam] },
		inConversation: ["relay"], onSend: {}, agentName: "Relay", showsVoiceControls: true, previewVoice: voice
	)
}

@MainActor
private func save<V: View>(
	_ view: V, name: String, dark: Bool, width: CGFloat = 402, height: CGFloat? = nil,
	canvas: Color = MaskinSurface.card
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

private let traceStart = Date(timeIntervalSince1970: 1_800_000_000)
private let liveTurn = ActivityTurn(
	sessionID: "s1", messageID: 4, startedAt: traceStart, status: .running,
	steps: [
		ActivityStep(id: "1-0", kind: .thinking, label: "Thinking…", status: .completed),
		ActivityStep(id: "2-0", kind: .toolUse, label: "Using Read", detail: "apps/web/src/routes/index.tsx"),
		ActivityStep(id: "3-0", kind: .toolUse, label: "Using Bash", detail: "pnpm test", status: .running),
	])
private let doneTurn = ActivityTurn(
	sessionID: "s1", messageID: 4, startedAt: traceStart, finishedAt: traceStart.addingTimeInterval(8),
	containsReply: true, steps: liveTurn.steps.map { var step = $0; step.status = .completed; return step })

/// The surrounding states a thread shows next to messages: question card, working, live trace, a
/// finished turn, a message on its way, held back, and one that failed.
@MainActor
private func statesScreen() -> some View {
	func message(_ id: Int, _ who: ChatParticipant, _ text: String, status: ChatMessage.Status = .sent, metadata: JSONValue? = nil) -> ChatMessage {
		var m = ChatMessage.confirmed(
			serverID: id, conversationID: "c", actorID: who.id, actorName: who.name, author: who.kind, content: text,
			createdAt: Date().addingTimeInterval(-300), metadata: metadata)
		m.status = status
		return m
	}
	let question: JSONValue = .object([
		"question": .object(["questions": .array([.object([
			"header": .string("Rollout"), "question": .string("How should the onboarding change ship?"),
			"options": .array([
				.object(["label": .string("7-day window"), "description": .string("Ships with cycle 1; about 18 support tickets"), "recommended": .bool(true)]),
				.object(["label": .string("Hold"), "description": .string("Nothing ships this cycle")]),
			]),
		])])])
	])
	func row(_ m: ChatMessage, _ author: Bool = true) -> some View {
		MessageRow(message: m, isOwn: m.actorID == "me", showsAuthor: author, onRetrySend: {}, onDiscard: {}, onRetryAgent: {})
	}
	return VStack(alignment: .leading, spacing: MaskinSpace.s7) {
		row(message(1, relay, "One decision before I ship this.", metadata: question))
		row(message(2, me, "Go with the 7-day window."))
		FinishedTraceView(turn: doneTurn)
		row(message(3, relay, "Done. The rollout is scheduled."))
		LiveActivityView(agent: relay, fallbackActivity: nil, turn: liveTurn, startedAt: traceStart, onStop: {})
		WorkingIndicator(agent: relay)
		row(message(4, me, "Can you also check billing?", status: .sending))
		row(message(5, me, "And draft the customer note", status: .waiting("Offline")))
		row(message(6, me, "Ping legal about the addendum", status: .failed("No connection")))
		ResumeBanner(agent: relay) {}
	}
	.frame(maxWidth: .infinity, alignment: .leading)
}

/// Two days of messages in a real scroll view with pinned section headers, to check a header pins.
@MainActor
private func pinnedDaysScreen() -> some View {
	func message(_ id: Int, _ who: ChatParticipant, _ text: String, daysAgo: Double) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: who.id, actorName: who.name, author: who.kind, content: text,
			createdAt: Date().addingTimeInterval(-daysAgo * 86_400))
	}
	var rows: [ChatMessage] = []
	for i in 1...8 { rows.append(message(i, i % 2 == 0 ? me : sam, "Message number \(i) on an earlier day, long enough to take up some space on screen.", daysAgo: 3)) }
	for i in 9...16 { rows.append(message(i, i % 2 == 0 ? me : relay, "Message number \(i) from today with a little more text so it wraps onto a second line.", daysAgo: 0)) }
	let items = ThreadLayout.items(for: rows)
	let sections = ThreadLayout.sections(for: items)
	return ScrollView {
		LazyVStack(alignment: .leading, spacing: MaskinSpace.s5, pinnedViews: [.sectionHeaders]) {
			ForEach(sections) { section in
				Section {
					ForEach(section.items) { item in
						if case .message(let m, let shows) = item {
							MessageRow(message: m, isOwn: m.actorID == "me", showsAuthor: shows, onRetrySend: {}, onDiscard: {}, onRetryAgent: {})
						}
					}
				} header: {
					if let day = section.day { DayHeader(label: ThreadLayout.dayLabel(day)) }
				}
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
	}
}

// MARK: - Threaded replies (design mock; not in the app)

/// "4 replies · last reply 12m ago" under a message: who replied, how many, how fresh, and unread.
private struct ThreadSummaryMock: View {
	let people: [ChatParticipant]
	let count: Int
	let last: String
	var unread = false

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			HStack(spacing: -MaskinSpace.s3) {
				ForEach(people) { person in
					ActorAvatar(name: person.name, kind: person.kind == .agent ? .agent : .human, size: MaskinSpace.s11, seed: person.id)
						.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: 2))
				}
			}
			Text(count == 1 ? "1 reply" : "\(count) replies").maskinText(.caption).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.accentStrong)
			Text("Last reply \(last)").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: 0)
			if unread { Circle().fill(MaskinColor.accent).frame(width: 8, height: 8) }
			Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(MaskinColor.ink5)
		}
		.padding(.horizontal, MaskinSpace.s6).padding(.vertical, MaskinSpace.s4)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
	}
}

@MainActor
private func threadMessage(_ id: Int, _ who: ChatParticipant, _ text: String, minutes: Double) -> ChatMessage {
	.confirmed(
		serverID: id, conversationID: "c", actorID: who.id, actorName: who.name, author: who.kind, content: text,
		createdAt: Date().addingTimeInterval(-minutes * 60))
}

@MainActor
private func threadRow(_ m: ChatMessage, _ author: Bool = true) -> some View {
	MessageRow(message: m, isOwn: m.actorID == "me", showsAuthor: author, onRetrySend: {}, onDiscard: {}, onRetryAgent: {})
}

/// The conversation with thread summaries under the messages that have replies.
@MainActor
private func threadsInChatScreen() -> some View {
	VStack(spacing: 0) {
		HStack {
			Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
			Spacer()
			VStack(spacing: 0) {
				Text("Relay").maskinText(.subhead).fontWeight(.semibold)
				Text("Q4 pipeline review").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			Spacer()
			Image(systemName: "ellipsis")
		}
		.foregroundStyle(MaskinColor.ink)
		.padding(.horizontal, MaskinSpace.s9).padding(.vertical, MaskinSpace.s7)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			threadRow(threadMessage(1, sam, "Can you pull together where the pipeline stands before Thursday?", minutes: 90))
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				threadRow(threadMessage(2, relay, "Here is where the pipeline stands:\n\n- **3 bets** are blocked on legal review\n- **Billing migration** is high risk\n- Two insights need a decision from you", minutes: 85))
				ThreadSummaryMock(people: [sam, me, relay], count: 4, last: "12m ago", unread: true)
			}
			threadRow(threadMessage(3, me, "Thanks, I'll go through the billing one tonight.", minutes: 40))
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				threadRow(threadMessage(4, sam, "Legal answered on the data addendum, two days turnaround.", minutes: 30))
				ThreadSummaryMock(people: [me], count: 1, last: "28m ago")
			}
			threadRow(threadMessage(5, relay, "Noted. I'll hold the importer rollout until Thursday.", minutes: 5))
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		Spacer(minLength: 0)
	}
}

/// The thread itself: the message it is about, the replies, and a composer that says where it will land.
@MainActor
private func threadScreen() async -> some View {
	let bar = await composer("", voice: .idle, placeholder: "Reply in thread…")
	return VStack(spacing: 0) {
		HStack {
			Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
			Spacer()
			VStack(spacing: 0) {
				Text("Thread").maskinText(.subhead).fontWeight(.semibold)
				Text("Q4 pipeline review").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			Spacer()
			Image(systemName: "ellipsis")
		}
		.foregroundStyle(MaskinColor.ink)
		.padding(.horizontal, MaskinSpace.s9).padding(.vertical, MaskinSpace.s7)
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			threadRow(threadMessage(2, relay, "Here is where the pipeline stands:\n\n- **3 bets** are blocked on legal review\n- **Billing migration** is high risk\n- Two insights need a decision from you", minutes: 85))
			HStack(spacing: MaskinSpace.s5) {
				Text("4 replies").maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3)
				Rectangle().fill(MaskinSurface.line).frame(height: 1)
			}
			.padding(.vertical, MaskinSpace.s4)
			threadRow(threadMessage(6, sam, "Which of the three is the biggest risk for Thursday?", minutes: 80))
			threadRow(threadMessage(7, relay, "Billing migration: 12 days of work and legal has not signed off. The other two can wait.", minutes: 78))
			threadRow(threadMessage(8, me, "Draft a note to legal about it.", minutes: 20))
			WorkingIndicator(agent: relay)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		Spacer(minLength: 0)
		VStack(spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "checkmark.square.fill").foregroundStyle(MaskinColor.accent)
				Text("Also send to Q4 pipeline review").maskinText(.caption).foregroundStyle(MaskinColor.ink3)
				Spacer()
			}
			.padding(.horizontal, MaskinSpace.s9)
			bar
		}
	}
}

/// How a thread starts: the tap bar under a message, and the long-press menu.
@MainActor
private func threadEntryScreen() -> some View {
	VStack(alignment: .leading, spacing: MaskinSpace.s9) {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text("Tap a message").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			threadRow(threadMessage(2, relay, "Billing migration is the biggest risk for Thursday.", minutes: 20))
			HStack(spacing: MaskinSpace.s4) {
				ForEach([("arrow.turn.down.right", "Reply in thread", true), ("arrowshape.turn.up.left", "Quote", false), ("doc.on.doc", "Copy", false), ("square.and.arrow.up", "Share", false)], id: \.1) { item in
					Label(item.1, systemImage: item.0).maskinText(.caption).fontWeight(.semibold)
						.foregroundStyle(item.2 ? MaskinColor.accentStrong : MaskinColor.ink3)
						.padding(.horizontal, MaskinSpace.s6).frame(minHeight: 36)
						.background(item.2 ? MaskinColor.accentTint2 : MaskinSurface.fill, in: Capsule())
				}
			}
		}
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text("Swipe a message left").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			HStack(spacing: 0) {
				threadRow(threadMessage(2, relay, "Billing migration is the biggest risk for Thursday.", minutes: 20)).offset(x: -56)
				Image(systemName: "arrow.turn.down.right").font(.system(size: 17, weight: .semibold))
					.foregroundStyle(MaskinColor.accentStrong).frame(width: 44, height: 44)
					.background(MaskinColor.accentTint2, in: Circle()).offset(x: -52)
			}
		}
		VStack(alignment: .leading, spacing: 0) {
			Text("Long-press the avatar or name").maskinText(.caption).foregroundStyle(MaskinColor.ink4).padding(.bottom, MaskinSpace.s3)
			VStack(alignment: .leading, spacing: 0) {
				ForEach([("arrow.turn.down.right", "Reply in thread"), ("arrowshape.turn.up.left", "Quote"), ("doc.on.doc", "Copy"), ("selection.pin.in.out", "Select text"), ("square.and.arrow.up", "Share"), ("speaker.wave.2", "Read aloud")], id: \.1) { item in
					Label(item.1, systemImage: item.0).maskinText(.body).foregroundStyle(MaskinColor.ink)
						.padding(.horizontal, MaskinSpace.s8).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
				}
			}
			.frame(width: 250)
			.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		}
	}
	.padding(MaskinSpace.s9)
	.frame(maxWidth: .infinity, alignment: .leading)
}

@Suite("Composer design states", .enabled(if: ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] != nil, "design-review renders; set COMPOSER_DESIGN_DIR to run"))
@MainActor
struct ComposerDesignSnapshotTests {
	@Test("a day header pins while its messages scroll", arguments: [false])
	func pinned(dark: Bool) throws {
		#if canImport(AppKit)
		let hosting = NSHostingView(rootView: pinnedDaysScreen().frame(width: 402, height: 700).background(MaskinSurface.card))
		hosting.appearance = NSAppearance(named: .aqua)
		hosting.frame = NSRect(x: 0, y: 0, width: 402, height: 700)
		hosting.layoutSubtreeIfNeeded()
		RunLoop.main.run(until: Date().addingTimeInterval(0.4))
		func scrollView(in view: NSView) -> NSScrollView? {
			if let found = view as? NSScrollView { return found }
			for sub in view.subviews { if let found = scrollView(in: sub) { return found } }
			return nil
		}
		let scroller = scrollView(in: hosting)
		scroller?.contentView.scroll(to: NSPoint(x: 0, y: 1100))
		scroller?.reflectScrolledClipView(scroller!.contentView)
		hosting.layoutSubtreeIfNeeded()
		RunLoop.main.run(until: Date().addingTimeInterval(0.4))
		guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return }
		hosting.cacheDisplay(in: hosting.bounds, to: rep)
		let dir = ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] ?? NSTemporaryDirectory()
		try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("pinned-scrolled.png"))
		#expect(scroller != nil)
		#endif
	}

	@Test("threaded replies design renders", arguments: [false, true])
	func threads(dark: Bool) async throws {
		try save(threadsInChatScreen(), name: "th1-in-chat", dark: dark, height: 874)
		try save(await threadScreen(), name: "th2-thread", dark: dark, height: 874)
		try save(threadEntryScreen(), name: "th3-entry", dark: dark, height: 874)
	}

	@Test("surrounding thread states render", arguments: [false, true])
	func surrounding(dark: Bool) throws {
		try save(statesScreen(), name: "t-surrounding-states", dark: dark, height: 1350)
	}

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
