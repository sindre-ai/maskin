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

private struct StubUploader: ChatFileUploading {
	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		ChatAttachmentRef(fileID: UUID().uuidString, name: name, mimeType: mimeType, sizeBytes: data.count)
	}
}

private let me = ChatParticipant(id: "me", name: "Alex Preview", kind: .human)
private let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)
private let sam = ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)

/// A composer model in a given state, with any stub uploads settled so chips show their ready state.
@MainActor
private func model(
	_ text: String = "", attach: [(String, String)] = [], reply: (String, String)? = nil,
	edit: (String, String)? = nil, mention: ChatMention? = nil
) async -> ChatComposerModel {
	let model = ChatComposerModel(uploader: StubUploader(), selfActorID: "me")
	model.text = text
	if let reply { model.reply(to: reply.0, text: reply.1) }
	if let edit { model.beginEdit(messageID: edit.0, originalText: edit.1) }
	if let mention { model.addMention(mention) }
	for (name, mime) in attach {
		model.attach(name: name, mimeType: mime) { PreparedChatFile(name: name, mimeType: mime, data: Data(count: 480_000)) }
	}
	for _ in 0..<100 where model.isUploading { try? await Task.sleep(for: .milliseconds(10)) }
	return model
}

@MainActor
private func config(
	_ variant: MaskinComposerVariant = .floating, placeholder: String = "Message Forge", attach: Bool = true,
	mic: Bool = true, send: Bool = true, goLive: Bool = false, roster: MentionRoster? = nil
) -> MaskinComposerConfig {
	MaskinComposerConfig(
		variant: variant, placeholder: placeholder, showsAttach: attach, showsMic: mic, showsSend: send,
		goLive: goLive ? {} : nil, suggestions: { _ in [forge, sam] }, inConversation: ["forge"], roster: roster)
}

/// The `ImageRenderer` pattern from `ForYouSnapshotTests`: render light and dark at the phone and
/// iPad widths, fail if nothing renders, write a PNG when `COMPOSER_SNAPSHOT_DIR` is set.
@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String, topRoom: CGFloat = 0) throws {
	let framed = view
		.padding(.top, topRoom)
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
	guard let dir = ProcessInfo.processInfo.environment["COMPOSER_SNAPSHOT_DIR"] else { return }
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("MaskinComposer snapshots")
@MainActor
struct MaskinComposerSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	@Test("floating: empty, with text, busy (Stop), and the Team room's Go live", arguments: [false, true])
	func floating(dark: Bool) async throws {
		let empty = await model()
		let typed = await model("Sounds good, send me the draft when it is ready and flag anything risky.")
		for width in Self.widths {
			try render(MaskinComposer(model: empty, config: config(), onSend: {}), width: width, dark: dark, name: "floating-empty")
			try render(MaskinComposer(model: typed, config: config(), onSend: {}), width: width, dark: dark, name: "floating-text")
			try render(
				MaskinComposer(model: empty, config: config(), busy: true, onStop: {}, onSend: {}), width: width, dark: dark,
				name: "floating-busy")
			try render(
				MaskinComposer(model: empty, config: config(placeholder: "Message the team", mic: false, goLive: true), onSend: {}),
				width: width, dark: dark, name: "floating-golive")
		}
		let busy = MaskinComposer(model: empty, config: config(), busy: true, onStop: {}, onSend: {})
			.composerPreview(.init())
		#expect(busy.lastSlot == .stop)
		#expect(busy.showsMicBesideStop, "a busy agent must not take dictation away")
		let room = MaskinComposer(model: empty, config: config(mic: false, goLive: true), busy: true, onStop: {}, onSend: {})
			.composerPreview(.init())
		#expect(room.lastSlot == .stop && !room.showsMicBesideStop, "a composer without a mic gets none beside Stop")
		let idle = MaskinComposer(model: empty, config: config(), busy: false, onStop: {}, onSend: {}).composerPreview(.init())
		#expect(!idle.showsMicBesideStop && idle.lastSlot == .mic)
		#expect(MaskinComposer(model: typed, config: config(), busy: true, onStop: {}, onSend: {}).lastSlot == .send)
		#expect(MaskinComposer(model: empty, config: config(), busy: true, onSend: {}).composerPreview(.init()).lastSlot == .mic, "busy without onStop cannot show Stop")
	}

	@Test("inline: thread reply, and the Hold reason field without send", arguments: [false, true])
	func inline(dark: Bool) async throws {
		let empty = await model()
		let reason = await model("Waiting on legal")
		for width in Self.widths {
			try render(
				MaskinComposer(model: empty, config: config(.inline, placeholder: "Reply in thread"), onSend: {}), width: width,
				dark: dark, name: "inline-reply")
			try render(
				MaskinComposer(model: reason, config: config(.inline, placeholder: "Why hold this?", attach: false, send: false), onSend: {}),
				width: width, dark: dark, name: "inline-hold")
		}
		let hold = MaskinComposer(model: reason, config: config(.inline, attach: false, send: false), onSend: {})
		#expect(hold.lastSlot == .none, "the sheet's own buttons commit a Hold reason")
	}

	@Test("dictating: discard, bars, transcript, done", arguments: [false, true])
	func dictating(dark: Bool) async throws {
		let typed = await model("Can you pull together the importer numbers")
		for width in Self.widths {
			try render(
				MaskinComposer(model: typed, config: config(), onSend: {}).composerPreview(.init(dictating: true)), width: width,
				dark: dark, name: "dictating")
		}
	}

	@Test("quote strip: replying and editing", arguments: [false, true])
	func quote(dark: Bool) async throws {
		let replying = await model(
			"On it.", reply: ("Forge", "The importer fix shipped this morning; two insights still need a decision from you."))
		let editing = await model(edit: ("12", "Yes please, and flag anything risky."))
		#expect(ComposerQuoteStrip.content(for: replying)?.label == "Replying to Forge")
		#expect(ComposerQuoteStrip.content(for: editing)?.label == "Editing message")
		#expect(ComposerQuoteStrip.content(for: editing)?.text == "Yes please, and flag anything risky.")
		for width in Self.widths {
			try render(MaskinComposer(model: replying, config: config(), onSend: {}), width: width, dark: dark, name: "quote-reply")
			try render(MaskinComposer(model: editing, config: config(), onSend: {}), width: width, dark: dark, name: "quote-edit")
		}
	}

	@Test("attachments and mentions as 36pt chips, plus a drag over the bar", arguments: [false, true])
	func attachments(dark: Bool) async throws {
		let m = await model(
			"Here is the kickoff photo and the brief", attach: [("kickoff.jpg", "image/jpeg"), ("Launch brief.pdf", "application/pdf")],
			mention: ChatMention(id: "sam", name: "Sam Berg", kind: .human))
		#expect(m.attachments.allSatisfy { $0.ref != nil })
		for width in Self.widths {
			try render(MaskinComposer(model: m, config: config(), onSend: {}), width: width, dark: dark, name: "attachments")
			try render(
				MaskinComposer(model: m, config: config(), onSend: {}).composerPreview(.init(dropTargeted: true)), width: width,
				dark: dark, name: "attachments-drop")
		}
	}

	@Test("the + menu and the @ popover float above the bar", arguments: [false, true])
	func popovers(dark: Bool) async throws {
		let empty = await model()
		let mentioning = await model("Looping in @")
		for width in Self.widths {
			try render(
				MaskinComposer(model: empty, config: config(), onSend: {}).composerPreview(.init(trayOpen: true)), width: width,
				dark: dark, name: "attach-menu", topRoom: 320)
			try render(
				MaskinComposer(model: mentioning, config: config(), onSend: {}), width: width, dark: dark, name: "mention-popover",
				topRoom: 140)
			try render(
				ComposerAttachMenu(actions: ComposerAttachAction.allCases, onPick: { _ in }), width: width, dark: dark,
				name: "attach-menu-rows")
			try render(
				MentionSuggestions(candidates: [forge, sam], inConversation: ["forge"], onPick: { _ in }), width: width, dark: dark,
				name: "mention-rows")
		}
		let roster = MentionRoster(people: [
			MentionPerson(id: "forge", name: "Forge", kind: .agent),
			MentionPerson(id: "sam", name: "Sam Berg", kind: .human, roleLabel: "Human · Owner"),
		])
		let bar = MaskinComposer(model: mentioning, config: config(roster: roster), onSend: {})
		#expect(bar.config.roster?.people.count == 2)
		for width in Self.widths {
			try render(bar, width: width, dark: dark, name: "mention-popover-roster", topRoom: 140)
		}
	}

	@Test("the old ChatComposer wrapper still renders every voice state", arguments: [false, true])
	func wrapper(dark: Bool) async throws {
		let typed = await model("what changed since Friday and what is blocked")
		for width in Self.widths {
			for (name, voice) in [("wrapper-idle", ComposerVoiceState.idle), ("wrapper-dictating", .dictating), ("wrapper-live", .live(.listening))] {
				try render(
					ChatComposer(
						model: typed, placeholder: "Message Forge", suggestions: { _ in [forge] }, inConversation: ["forge"],
						onSend: {}, agentName: "Forge", showsVoiceControls: true, previewVoice: voice),
					width: width, dark: dark, name: name)
			}
		}
	}

	@Test("the gallery preview renders")
	func gallery() throws {
		try render(MaskinComposerGallery().frame(height: 1400), width: 402, dark: false, name: "gallery")
	}
}

// MARK: - Design review renders (real controls)

/// A hosting view draws the real controls (menus, scroll views, field text and placeholders);
/// `ImageRenderer` does not. Opt in with `COMPOSER_DESIGN_DIR=… swift test --filter "Composer design"`.
@MainActor
private func save<V: View>(_ view: V, name: String, dark: Bool, width: CGFloat = 402, height: CGFloat? = nil) throws {
	#if canImport(AppKit)
	let framed = view
		.padding(MaskinSpace.s7)
		.frame(width: width, height: height, alignment: .bottom)
		.background(MaskinSurface.grouped)
	let hosting = NSHostingView(rootView: framed)
	hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
	hosting.frame = NSRect(x: 0, y: 0, width: width, height: height ?? 10)
	hosting.layoutSubtreeIfNeeded()
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

@Suite(
	"Composer design states",
	.enabled(if: ProcessInfo.processInfo.environment["COMPOSER_DESIGN_DIR"] != nil, "design-review renders; set COMPOSER_DESIGN_DIR to run"))
@MainActor
struct ComposerDesignSnapshotTests {
	@Test("composer states render with real controls", arguments: [false, true])
	func states(dark: Bool) async throws {
		try save(MaskinComposer(model: await model(), config: config(), onSend: {}), name: "1-empty", dark: dark)
		try save(
			MaskinComposer(model: await model("Sounds good, send me the draft"), config: config(), onSend: {}), name: "2-typing", dark: dark)
		try save(
			MaskinComposer(model: await model(), config: config(), busy: true, onStop: {}, onSend: {}), name: "3-busy", dark: dark)
		try save(
			MaskinComposer(model: await model("Can you pull together the importer numbers"), config: config(), onSend: {})
				.composerPreview(.init(dictating: true)),
			name: "4-dictating", dark: dark)
		try save(
			MaskinComposer(model: await model("On it.", reply: ("Forge", "The importer fix shipped.")), config: config(), onSend: {}),
			name: "5-reply", dark: dark)
		try save(
			MaskinComposer(
				model: await model("Here's the kickoff photo and the brief", attach: [("kickoff.jpg", "image/jpeg"), ("Launch brief.pdf", "application/pdf")]),
				config: config(), onSend: {}),
			name: "6-attachments", dark: dark)
		try save(
			MaskinComposer(model: await model(), config: config(.inline, placeholder: "Reply in thread"), onSend: {}), name: "7-inline",
			dark: dark)
		try save(
			MaskinComposer(model: await model(), config: config(), onSend: {}).composerPreview(.init(trayOpen: true)).padding(.top, 320),
			name: "8-attach-menu", dark: dark)
		try save(
			MaskinComposer(model: await model("Looping in @"), config: config(), onSend: {}).padding(.top, 140), name: "9-mention",
			dark: dark)
		try save(MaskinComposerGallery(), name: "gallery", dark: dark, height: 1500)
	}
}
