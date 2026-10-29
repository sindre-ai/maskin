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

private let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
private let draftID = "11111111-2222-3333-4444-555555555555"
private let pageID = "33333333-2222-3333-4444-555555555555"
private let noteID = "44444444-2222-3333-4444-555555555555"

private struct StubObjects: ObjectDraftsRemote {
	func detail(objectId: String) async throws -> ObjectDetail {
		let preview = ObjectPreview(
			kind: "email", label: "Email", recipients: [.init(role: "to", name: "Torben Vestergaard", address: "torben@example.dk")],
			subject: "Next steps for the pilot",
			body: "Hi Torben,\n\nThanks for the call on Tuesday. Here is what we agreed: we start with two teams, review after four weeks and decide on the rest then.\n\nLet me know if that works for you.\n\nBest,\nSam",
			warnings: ["Torben has not been emailed before."], contentHash: "h1")
		return ObjectDetail(
			object: WorkObject(id: objectId, type: "task", title: "Email to Torben", content: preview.body, status: "draft"),
			workspaceId: ws, preview: preview)
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		throw ObjectApprovalError.changed
	}
}

private struct StubFiles: FilesRemote {
	func file(id: String) async throws -> FileDetail {
		FileDetail(
			id: id, name: "Pilot plan.md", mimeType: "text/markdown", sizeBytes: 80,
			data: Data("# Pilot plan\n\n- Two teams first\n- Review after four weeks\n- Decide on the rest".utf8))
	}

	func summaries(ids: [String]) async throws -> [FileSummary] {
		ids.map {
			$0 == pageID
				? FileSummary(id: $0, name: "Pilot plan.md", mimeType: "text/markdown", sizeBytes: 80)
				: FileSummary(id: $0, name: "Landing page.html", mimeType: "text/html", sizeBytes: 4000)
		}
	}
}

private let taskID = "55555555-2222-3333-4444-555555555555"
private let goneID = "66666666-2222-3333-4444-555555555555"

/// Answers a task for `taskID` and "not found" for anything else.
private struct StubTasks: ObjectDraftsRemote {
	func detail(objectId: String) async throws -> ObjectDetail {
		guard objectId == taskID else { throw ObjectsError(ObjectsRemoteMessages.notFound) }
		return ObjectDetail(
			object: WorkObject(
				id: objectId, type: "task", title: "Fix the login code loop",
				content: "The login page keeps asking for the code twice. Reproduced on iOS 26 with a fresh install.",
				status: "in_progress", metadata: ["priority": "P2"], driverId: "agent-1",
				updatedAt: Date(timeIntervalSinceNow: -7200)),
			workspaceId: ws)
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		throw ObjectApprovalError.changed
	}
}

@MainActor
@Suite("Linked cards render")
struct LinkedCardSnapshotTests {
	/// Lays the view out in a hosting view (a real layout pass, so measured heights settle, which
	/// `ImageRenderer` does not wait for) and writes a PNG.
	private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String, largest: Bool = false) async throws {
		#if canImport(AppKit)
		let framed = view
			.padding(MaskinSpace.s9)
			.frame(width: width)
			.background(MaskinSurface.grouped)
			.environment(\.colorScheme, dark ? .dark : .light)
			.environment(\.dynamicTypeSize, largest ? .accessibility5 : .large)
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
		let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light")\(largest ? "-largest" : "").png")
		try rep.representation(using: .png, properties: [:])?.write(to: url)
		#endif
	}

	private func store() async -> LinkedItemStore {
		let store = LinkedItemStore(objects: StubObjects(), files: StubFiles(), workspaceID: { ws })
		await store.resolve([
			LinkedTarget(kind: .object, uuid: draftID), LinkedTarget(kind: .file, uuid: pageID),
		])
		await store.loadText(of: FileReference(id: pageID, name: "Pilot plan.md", mimeType: "text/markdown", sizeBytes: 80))
		return store
	}

	@Test("a draft card, contracted and open, and a markdown file card, at phone and tablet widths")
	func cards() async throws {
		let store = await store()
		let target = LinkedTarget(kind: .object, uuid: draftID)
		guard case .draft(let object, let preview)? = store.item(for: target) else {
			Issue.record("draft did not resolve")
			return
		}
		#expect(store.isCard(LinkedTarget(kind: .file, uuid: pageID)))
		for dark in [false, true] {
			for width in [375.0, 768.0] {
				let content = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					LinkedDraftCard(object: object, preview: preview)
					LinkedDraftCard(object: object, preview: preview, defaultExpanded: true)
					LinkedFileCard(
						file: FileReference(id: pageID, name: "Pilot plan.md", mimeType: "text/markdown", sizeBytes: 80),
						defaultExpanded: true)
					LinkedFileCard(file: FileReference(id: "x", name: "Landing page.html", mimeType: "text/html", sizeBytes: 4000))
					LinkedPlainRow(target: LinkedTarget(kind: .object, uuid: noteID), title: "Torben Vestergaard", kindLabel: "Contact")
				}
				.environment(\.linkedItems, store)
				try await render(content, width: width, dark: dark, name: "linked-cards")
			}
		}
	}

	@Test("a message with a stand-alone link shows the card in place and keeps its words")
	func inMessage() async throws {
		let store = await store()
		let message = ChatMessage(
			id: "m1", serverID: 1, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent,
			content:
				"I wrote the email.\n\n[Email to Torben](https://maskin.io/\(ws)/objects/\(draftID))\n\nThe plan is in https://maskin.io/\(ws)/files/\(pageID) if you want to check it.",
			createdAt: Date(timeIntervalSince1970: 1_790_000_000))
		for dark in [false, true] {
			let row = MessageRow(message: message, isOwn: false, showsAuthor: true)
				.environment(\.linkedItems, store)
			try await render(row, width: 375, dark: dark, name: "linked-message")
		}
	}

	private func objectStore() async -> LinkedItemStore {
		let store = LinkedItemStore(
			objects: StubTasks(), files: StubFiles(),
			actors: { [ActorRef(id: "agent-1", name: "Developer", isAgent: true)] }, workspaceID: { ws })
		await store.resolve([LinkedTarget(kind: .object, uuid: taskID), LinkedTarget(kind: .object, uuid: goneID)])
		// The owner's name arrives with its own read.
		for _ in 0..<40 where store.owner(for: "agent-1") == nil { try? await Task.sleep(for: .milliseconds(50)) }
		return store
	}

	@Test("an object card, open, folded, loading and deleted, at 390 wide, light and dark, default and largest text")
	func objectCards() async throws {
		let store = await objectStore()
		let gone = LinkedTarget(kind: .object, uuid: goneID)
		guard case .object(let object)? = store.item(for: LinkedTarget(kind: .object, uuid: taskID)) else {
			Issue.record("the task did not resolve")
			return
		}
		#expect(store.item(for: gone) == .deleted(gone))
		for dark in [false, true] {
			for largest in [false, true] {
				let content = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					LinkedObjectCard(object: object)
					LinkedObjectCard(object: object, defaultFolded: true)
					LinkedCardSkeleton()
					LinkedDeletedCard()
				}
				.environment(\.linkedItems, store)
				try await render(content, width: 390, dark: dark, name: "linked-object-cards", largest: largest)
			}
		}
	}

	@Test("a stand-alone object link is a card in the message, and in your own message too")
	func objectInMessage() async throws {
		let store = await objectStore()
		let link = "[Fix the login code loop](https://maskin.io/\(ws)/objects/\(taskID))"
		let theirs = ChatMessage(
			id: "m1", serverID: 1, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent,
			content: "I looked at it.\n\n\(link)\n\nThe fix is small.", createdAt: Date(timeIntervalSince1970: 1_790_000_000))
		let own = ChatMessage(
			id: "m2", serverID: 2, conversationID: "c", actorID: "me", actorName: "Me", author: .human,
			content: "Is this the one?\n\n\(link)", createdAt: Date(timeIntervalSince1970: 1_790_000_100))
		let alone = ChatMessage(
			id: "m3", serverID: 3, conversationID: "c", actorID: "me", actorName: "Me", author: .human,
			content: link, createdAt: Date(timeIntervalSince1970: 1_790_000_200))
		for dark in [false, true] {
			let column = VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				MessageRow(message: theirs, isOwn: false, showsAuthor: true)
				MessageRow(message: own, isOwn: true, showsAuthor: false)
				MessageRow(message: alone, isOwn: true, showsAuthor: false)
			}
			.environment(\.linkedItems, store)
			try await render(column, width: 390, dark: dark, name: "linked-object-message")
		}
	}
}
