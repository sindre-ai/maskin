import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

private struct StaticSource: NotificationsSource {
	var rows: [AppNotification]
	func list() async throws -> [AppNotification] { rows }
	func setStatus(id: String, status: AppNotification.Status) async throws -> AppNotification {
		throw NotificationsError("unused")
	}
	func delete(id: String) async throws {}
	func respond(id: String, response: JSONValue) async throws -> AppNotification {
		throw NotificationsError("unused")
	}
	func actors(ids: [String]) async throws -> [NotificationActor] {
		[
			NotificationActor(id: "agent-1", name: "Relay Agent", isAgent: true),
			NotificationActor(id: "agent-2", name: "Compass", isAgent: true),
			NotificationActor(id: "human-1", name: "Sam Rivera", isAgent: false),
		]
	}
}

private let now = Date()

private let sample: [AppNotification] = [
	AppNotification(
		id: "1", workspaceId: "ws", kind: .needsInput, title: "Approve the pricing page copy?",
		content: "Relay rewrote the hero and the three plan cards. Review the diff and tell it whether to ship.",
		status: .pending, sourceActorId: "agent-1", createdAt: now.addingTimeInterval(-300),
		actions: [
			.init(id: "a", label: "Ship it", response: .string("ship"), style: .primary),
			.init(id: "b", label: "Hold for edits", response: .string("hold")),
		]),
	AppNotification(
		id: "2", workspaceId: "ws", kind: .alert, title: "Deploy failed on main",
		content: "The build stopped at the type-check step.", status: .pending,
		sourceActorId: "agent-2", createdAt: now.addingTimeInterval(-3600)),
	AppNotification(
		id: "3", workspaceId: "ws", kind: .goodNews, title: "Signups up 18% this week",
		content: "Mostly from the new onboarding flow.", status: .seen, sourceActorId: "agent-2",
		createdAt: now.addingTimeInterval(-86400)),
	AppNotification(
		id: "4", workspaceId: "ws", kind: .needsInput, title: "Which segment should we target first?",
		content: "Pick one so the outreach agent can start.", status: .resolved,
		sourceActorId: "human-1", createdAt: now.addingTimeInterval(-200_000),
		actions: [.init(id: "x", label: "Founders", response: .string("founders"))],
		response: .string("founders")),
]

@MainActor
private func loadedStore(_ rows: [AppNotification]) async -> NotificationsStore {
	let store = NotificationsStore(source: StaticSource(rows: rows), currentActorId: { "me" })
	await store.reload()
	return store
}

@MainActor
private func render<V: View>(_ view: V, name: String, width: CGFloat, dark: Bool) throws -> URL {
	let framed = view
		.frame(width: width, height: 874)
		.background(Color(white: dark ? 0.04 : 0.96))
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else { throw NotificationsError("render failed") }
	let dir = URL(
		fileURLWithPath: ProcessInfo.processInfo.environment["NOTIF_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
	try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	let url = dir.appendingPathComponent("notifications-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
	else { throw NotificationsError("no destination") }
	CGImageDestinationAddImage(dest, image, nil)
	guard CGImageDestinationFinalize(dest) else { throw NotificationsError("write failed") }
	return url
}

/// `List` is UIKit/AppKit-backed and renders as a placeholder under `ImageRenderer`, so the list
/// snapshot stacks the same `NotificationRow`s the screen uses in a plain `VStack`.
private struct RowsSnapshot: View {
	let store: NotificationsStore
	var body: some View {
		VStack(spacing: 0) {
			ForEach(store.notifications) { n in
				NotificationRow(
					notification: n, actor: store.actor(for: n.sourceActorId), isBusy: false
				) { _ in }
				.padding(.horizontal, 16)
				.padding(.vertical, 8)
				Divider()
			}
			Spacer(minLength: 0)
		}
		.frame(maxWidth: 720, maxHeight: .infinity, alignment: .top)
	}
}

@MainActor
@Suite("Notifications screen snapshots")
struct NotificationsSnapshotTests {
	@Test("list renders at phone and tablet widths in light and dark")
	func list() async throws {
		let store = await loadedStore(sample)
		for width in [402.0, 820.0] {
			for dark in [false, true] {
				let url = try render(
					RowsSnapshot(store: store), name: "list", width: width, dark: dark)
				let size = try #require(try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
				#expect(size > 5_000)
			}
		}
	}

	@Test("empty state renders")
	func empty() async throws {
		let store = await loadedStore([])
		for width in [402.0, 820.0] {
			for dark in [false, true] {
				_ = try render(NotificationsContent(store: store) { _ in }, name: "empty", width: width, dark: dark)
			}
		}
	}

	@Test("store feeding the screen has the expected unread count")
	func counts() async {
		let store = await loadedStore(sample)
		#expect(store.unreadCount == 2)
		#expect(store.actor(for: "agent-1")?.name == "Relay Agent")
	}
}
