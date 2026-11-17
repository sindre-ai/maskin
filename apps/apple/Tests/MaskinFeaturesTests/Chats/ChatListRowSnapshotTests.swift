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

private let now = Date()
private let me = ChatParticipant(id: "me", name: "Alex Preview", kind: .human)
private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
private let sage = ChatParticipant(id: "sage", name: "Sage", kind: .agent)

private func chat(
	_ id: String, hoursAgo: Double = 1, unread: Int = 0, pinned: Bool = false, snippet: String? = "Which one should I pick?"
) -> ConversationSummary {
	ConversationSummary(
		id: id, title: "Importer fix", lastMessageAt: now.addingTimeInterval(-hoursAgo * 3600), pinned: pinned,
		unreadCount: unread, snippet: snippet, participants: [me, relay, sage])
}

/// Every state a row can be in, as the list draws it.
private let states: [(name: String, chat: ConversationSummary)] = {
	var plain = chat("plain")
	plain.snippet = "Done. The importer fix is merged."
	var unread = chat("unread", unread: 3)
	unread.snippet = "Two options below."
	var needs = chat("needs")
	needs.needsYou = true
	var working = chat("working")
	working.working = [ChatWorkingAgent(agentID: "relay", sessionID: "s1"), ChatWorkingAgent(agentID: "sage", sessionID: "s2")]
	var stopped = chat("stopped")
	stopped.stopReason = .usageLimit
	stopped.retryMessageID = 7
	var pinnedChat = chat("pinned", pinned: true)
	pinnedChat.snippet = nil
	return [
		("plain", plain), ("unread", unread), ("needs-you", needs), ("working", working), ("stopped", stopped),
		("pinned-empty", pinnedChat),
	]
}()

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws -> CGImage? {
	let framed = view
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else { return nil }
	if let dir = ProcessInfo.processInfo.environment["CHATLIST_SNAPSHOT_DIR"] {
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
		#if canImport(AppKit)
		try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
		#elseif canImport(UIKit)
		try UIImage(cgImage: image).pngData()?.write(to: url)
		#endif
	}
	return image
}

@Suite("Chat list row renders")
@MainActor
struct ChatListRowSnapshotTests {
	@Test("every row state renders at phone width, light and dark")
	func rows() throws {
		for (name, c) in states {
			for dark in [false, true] {
				let image = try render(
					ChatListRowV2(conversation: c, currentActorID: "me", now: now).padding(MaskinSpace.s9), width: 375,
					dark: dark, name: "row-\(name)")
				#expect(image != nil, "row \(name) \(dark ? "dark" : "light") rendered")
			}
		}
	}

	@Test("the pills render with counts, and with the selected pill filled")
	func pills() throws {
		let counts: [ChatListFilter: Int] = [.needsYou: 2, .unread: 5, .working: 1, .later: 0]
		for pill in ChatListFilter.allCases {
			let image = try render(
				ChatListPills(filter: .constant(pill), counts: counts), width: 375, dark: false, name: "pills-\(pill.rawValue)")
			#expect(image != nil)
		}
	}

	@Test("the loading skeleton and the working line render")
	func others() throws {
		#expect(try render(ChatListSkeleton(), width: 375, dark: false, name: "skeleton") != nil)
		let line = ThreadWorkingLine(
			agents: [.init(name: "Relay", sessionID: "s1"), .init(name: "Sage", sessionID: "s2")], onOpenSession: { _ in })
		#expect(try render(line.padding(MaskinSpace.s9), width: 375, dark: false, name: "working-line") != nil)
	}
}
