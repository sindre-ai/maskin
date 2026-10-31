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

private let here = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
/// A workspace the reader belongs to.
private let acme = "9b2e1d63-1f1b-4a54-8d2f-bbbbbbbbbbbb"
/// A workspace the reader is not in.
private let stranger = "c3a4f5e7-2a2c-4b65-9e30-cccccccccccc"
private let noteID = "44444444-2222-3333-4444-555555555555"
private let pageID = "33333333-2222-3333-4444-555555555555"

/// Answers nothing: a link into another workspace must never reach it.
private struct NoObjects: ObjectDraftsRemote {
	func detail(objectId: String) async throws -> ObjectDetail { throw ObjectsError(ObjectsRemoteMessages.notFound) }

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		throw ObjectApprovalError.changed
	}
}

private struct NoFiles: FilesRemote {
	func file(id: String) async throws -> FileDetail {
		FileDetail(id: id, name: "n.md", mimeType: "text/markdown", sizeBytes: 0, data: Data())
	}

	func summaries(ids: [String]) async throws -> [FileSummary] { [] }
}

@MainActor
@Suite("Other-workspace cards and GitHub chips render")
struct LinkedOtherLinksSnapshotTests {
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

	/// A store for `here` whose switcher list holds only Acme Studio.
	private func makeStore() -> LinkedItemStore {
		LinkedItemStore(
			objects: NoObjects(), files: NoFiles(), workspaceID: { here },
			workspaceName: { $0.lowercased() == acme ? "Acme Studio" : nil })
	}

	private func otherLink(in workspace: String, kind: LinkedTarget.Kind = .object) -> LinkedOtherWorkspace {
		LinkedOtherWorkspace(
			target: LinkedTarget(kind: kind, uuid: kind == .object ? noteID : pageID, workspaceID: workspace),
			workspaceID: workspace)
	}

	private func makeLinkInfo() -> @MainActor (URL) -> MarkdownLinkInfo? {
		let directory = InternalLinkDirectory(store: { nil })
		return { directory.info(for: $0) }
	}

	@Test("the other-workspace card, named and unnamed, at 390 wide, light and dark, default and largest text")
	func placeholders() async throws {
		let store = makeStore()
		let member = otherLink(in: acme)
		let outsider = otherLink(in: stranger)
		#expect(member.title(workspaceName: store.workspaceName(for: acme)) == "Object in Acme Studio")
		#expect(outsider.title(workspaceName: store.workspaceName(for: stranger)) == "Object in another workspace")
		for dark in [false, true] {
			for largest in [false, true] {
				let content = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					LinkedOtherWorkspaceCard(link: member)
					LinkedOtherWorkspaceCard(link: outsider)
					LinkedOtherWorkspaceCard(link: otherLink(in: acme, kind: .file))
				}
				.environment(\.linkedItems, store)
				try await render(content, width: 390, dark: dark, name: "linked-other-workspace", largest: largest)
			}
		}
	}

	@Test("the GitHub chip for a pull request and an issue, on its own line and in a sentence")
	func gitHubChips() async throws {
		let pr = URL(string: "https://github.com/sindre-ai/maskin/pull/2653")!
		let issue = URL(string: "https://github.com/sindre-ai/maskin/issues/12")!
		let info = makeLinkInfo()
		#expect(info(pr)?.leavesApp == true)
		#expect(info(pr)?.title == "maskin #2653")
		#expect(info(issue)?.symbol == "smallcircle.filled.circle")
		for dark in [false, true] {
			for largest in [false, true] {
				let content = VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					MarkdownLinkCard(url: pr)
					MarkdownLinkCard(url: issue)
					MarkdownContent(
						"The fix is in \(pr.absoluteString) and the report is [the issue](\(issue.absoluteString)), if you want to read them.",
						style: .chat)
				}
				.environment(\.markdownInternalLinkInfo, info)
				try await render(content, width: 390, dark: dark, name: "linked-github-chip", largest: largest)
			}
		}
	}

	@Test("a message with an other-workspace link and a GitHub link draws the card and the chip")
	func inMessage() async throws {
		let store = makeStore()
		let message = ChatMessage(
			id: "m1", serverID: 1, conversationID: "c", actorID: "relay", actorName: "Relay", author: .agent,
			content:
				"The brief for Acme is here.\n\nhttps://maskin.io/\(acme)/objects/\(noteID)\n\nAnd this is not a member's:\n\nhttps://maskin.io/\(stranger)/objects/\(noteID)\n\nThe change is https://github.com/sindre-ai/maskin/pull/2653.\n\nhttps://github.com/sindre-ai/maskin/issues/12",
			createdAt: Date(timeIntervalSince1970: 1_790_000_000))
		#expect(store.isCard(LinkedTarget.parse(href: "https://maskin.io/\(acme)/objects/\(noteID)")!))
		for dark in [false, true] {
			let row = MessageRow(message: message, isOwn: false, showsAuthor: true)
				.environment(\.linkedItems, store)
				.environment(\.markdownInternalLinkInfo, makeLinkInfo())
			try await render(row, width: 390, dark: dark, name: "linked-other-links-message")
		}
	}
}
