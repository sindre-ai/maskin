import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

private let relay = ChatParticipant(id: "a1", name: "Relay", kind: .agent)
private let sam = ChatParticipant(id: "h1", name: "Sam Lee", kind: .human)
private let migration = CommentReference(id: "t2", title: "Write migration for devices", type: "task")
private let native = CommentReference(id: "b1", title: "Native iOS app", type: "bet")
private let spec = FileSummary(id: "f1", name: "retry-budget.pdf", mimeType: "application/pdf", sizeBytes: 182_400)

@MainActor
private func render<V: View>(_ name: String, width: CGFloat, dark: Bool, @ViewBuilder _ content: () -> V) throws {
	let view = content()
		.padding(MaskinSpace.s7)
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: view)
	renderer.scale = 2
	let image = try #require(renderer.cgImage)
	let dir = ProcessInfo.processInfo.environment["OBJECTS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory()
	let url = URL(fileURLWithPath: dir, isDirectory: true)
		.appendingPathComponent("comment-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
	#expect(image.width > 0 && image.height > 0)
}

@MainActor
@Suite("Comment composer snapshots")
struct CommentComposerSnapshotTests {
	@Test("pickers, chips and a posted comment render at phone and tablet widths, light and dark")
	func renders() throws {
		let actors = [
			ActorRef(id: "a1", name: "Relay", isAgent: true), ActorRef(id: "h1", name: "Sam Lee", isAgent: false),
		]
		for (width, dark) in [(402.0, false), (402.0, true), (820.0, false)] {
			try render("scene", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					MentionSuggestions(candidates: [relay, sam], inConversation: [], onPick: { _ in })
					ReferenceSuggestions(results: [migration, native], isSearching: false, onPick: { _ in })
					ReferenceSuggestions(results: [], isSearching: true, onPick: { _ in })
					ChipFlow {
						ReferenceChip(ref: migration, onRemove: {})
						ReferenceChip(ref: native, onRemove: {})
						AttachedFileChip(file: spec)
					}
					TimelineRow(
						item: TimelineItem(
							id: "c1", kind: .comment("@Relay can you check /Write migration? Notes are attached."),
							actorId: "h1", date: Date(), delivery: .sent, eventId: 1),
						name: "Sam Lee", isAgent: false, mentionable: actors, references: [migration],
						files: [spec], openObject: { _ in })
				}
			}
		}
	}
}
