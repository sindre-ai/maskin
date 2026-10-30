import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#endif

@testable import MaskinCore
@testable import MaskinFeatures

private let ws = "7d1f0c52-0e0a-4f43-9c1e-bbbbbbbbbbbb"
private let longTaskID = "55555555-2222-3333-4444-666666666666"

private struct NoFiles: FilesRemote {
	func file(id: String) async throws -> FileDetail {
		FileDetail(id: id, name: "None.md", mimeType: "text/markdown", sizeBytes: 0, data: Data())
	}

	func summaries(ids: [String]) async throws -> [FileSummary] { [] }
}

/// A task whose description is long enough to wrap past two lines at 390 wide.
private struct LongTask: ObjectDraftsRemote {
	func detail(objectId: String) async throws -> ObjectDetail {
		ObjectDetail(
			object: WorkObject(
				id: objectId, type: "task", title: "Fix the login code loop",
				content:
					"The login page keeps asking for the code twice. Reproduced on iOS 26 with a fresh install, on wifi and on mobile data, with the keyboard open and closed, after a force quit and after a restart of the phone.",
				status: "in_progress", metadata: ["priority": "P2"], driverId: "agent-1",
				updatedAt: Date(timeIntervalSinceNow: -7200)),
			workspaceId: ws)
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		throw ObjectApprovalError.changed
	}
}

@MainActor
@Suite("Task card summary lines")
struct LinkedObjectBubbleSnapshotTests {
	/// Same layout-then-bitmap approach as `LinkedCardSnapshotTests.render`.
	private func render<V: View>(_ view: V, dark: Bool, name: String) async throws {
		#if canImport(AppKit)
		let width: CGFloat = 390
		let framed = view
			.padding(MaskinSpace.s9)
			.frame(width: width)
			.background(MaskinSurface.grouped)
			.environment(\.colorScheme, dark ? .dark : .light)
			.environment(\.dynamicTypeSize, .large)
		let host = NSHostingView(rootView: framed)
		host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: width, height: 800), styleMask: [.borderless], backing: .buffered,
			defer: false)
		window.contentView = host
		for _ in 0..<25 {
			host.frame.size = NSSize(width: width, height: max(host.fittingSize.height, 10))
			host.layoutSubtreeIfNeeded()
			try? await Task.sleep(for: .milliseconds(100))
		}
		window.setContentSize(host.frame.size)
		guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
			Issue.record("no bitmap for \(name)")
			return
		}
		host.cacheDisplay(in: host.bounds, to: rep)
		let dir =
			ProcessInfo.processInfo.environment["CHATS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory() + "chats-snapshots"
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
		try rep.representation(using: .png, properties: [:])?.write(to: url)
		#endif
	}

	@Test("a task with a long description is one line in a bubble and two lines stand-alone, 390 wide, light and dark")
	func longDescription() async throws {
		let store = LinkedItemStore(
			objects: LongTask(), files: NoFiles(),
			actors: { [ActorRef(id: "agent-1", name: "Developer", isAgent: true)] }, workspaceID: { ws })
		await store.resolve([LinkedTarget(kind: .object, uuid: longTaskID)])
		for _ in 0..<40 where store.owner(for: "agent-1") == nil { try? await Task.sleep(for: .milliseconds(50)) }
		guard case .object(let object)? = store.item(for: LinkedTarget(kind: .object, uuid: longTaskID)) else {
			Issue.record("the task did not resolve")
			return
		}
		let link = "[Fix the login code loop](https://maskin.io/\(ws)/objects/\(longTaskID))"
		let inBubble = ChatMessage(
			id: "m1", serverID: 1, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent,
			content: "I looked at it.\n\n\(link)\n\nThe fix is small.", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
		let alone = ChatMessage(
			id: "m2", serverID: 2, conversationID: "c", actorID: "me", actorName: "Me", author: .human,
			content: link, createdAt: Date(timeIntervalSince1970: 1_790_000_200))
		for dark in [false, true] {
			let column = VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				MessageRow(message: inBubble, isOwn: false, showsAuthor: true)
				MessageRow(message: alone, isOwn: true, showsAuthor: false)
				LinkedObjectCard(object: object)
			}
			.environment(\.linkedItems, store)
			try await render(column, dark: dark, name: "linked-object-bubble-lines")
		}
	}
}
