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

// MARK: - Fixtures

private let now = Date(timeIntervalSinceNow: 0)
private func ago(_ minutes: Int) -> Date { now.addingTimeInterval(-Double(minutes * 60)) }

private let sampleActors = [
	ActorRef(id: "me", name: "Alex Preview", isAgent: false),
	ActorRef(id: "sigrid", name: "Sigrid Larsen", isAgent: false),
	ActorRef(id: "forge", name: "Forge", isAgent: true),
]

private let objects = [
	WorkObject(
		id: "t1", type: "task", title: "Wire up SSE reconnect with exponential backoff and jitter",
		content: "Reconnect with backoff.", status: "in_progress", driverId: "forge", updatedAt: ago(5),
		isStarred: true, unreadCount: 2, activeActivity: "Reading EventHub.swift"),
	WorkObject(id: "t3", type: "task", title: "Design empty states", status: "in_progress", driverId: "me", updatedAt: ago(90)),
	WorkObject(id: "b1", type: "bet", title: "Native iOS app", status: "active", driverId: "sigrid", updatedAt: ago(30)),
	WorkObject(id: "i1", type: "insight", title: "Users want push notifications", status: "new", updatedAt: ago(120)),
]

private let detailObject = WorkObject(
	id: "t1", type: "task", title: "Wire up SSE reconnect with exponential backoff and jitter",
	content: """
		The stream drops on cellular handoff. We need to:

		- Reconnect with **exponential backoff**
		- Resume from `Last-Event-ID`
		- Surface a quiet offline banner

		See the design notes for the retry budget.
		""",
	status: "in_progress", metadata: ["effort": "3", "area": "networking"], driverId: "forge", updatedAt: ago(5),
	isStarred: true, activeActivity: "Reading EventHub.swift")

private struct StubRemote: ObjectsRemote {
	func list(_ query: ObjectsQuery) async throws -> [WorkObject] { objects }
	func graph(objectId: String) async throws -> ObjectGraph {
		ObjectGraph(
			object: detailObject,
			links: [
				ObjectLink(id: "r1", relation: "blocks", isOutgoing: true, otherId: "t2", otherType: "task", otherTitle: "Write migration for devices", otherStatus: "todo"),
				ObjectLink(id: "r2", relation: "breaks_into", isOutgoing: false, otherId: "b1", otherType: "bet", otherTitle: "Native iOS app", otherStatus: "active"),
			],
			events: [
				ObjectEvent(id: 1, actorId: "sigrid", action: "created", createdAt: ago(300), summary: "created task"),
				ObjectEvent(id: 2, actorId: "me", action: "status_changed", createdAt: ago(100), summary: "moved status from todo to in progress"),
				ObjectEvent(id: 3, actorId: "forge", action: "commented", data: .object(["content": .string("Reconnect is flaky on cellular. I'm adding **backoff** with jitter and will report back.")]), createdAt: ago(20)),
				ObjectEvent(id: 4, actorId: "me", action: "commented", data: .object(["content": .string("Great, ship it behind the flag.")]), createdAt: ago(10)),
			])
	}
	func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject { detailObject }
	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject { detailObject }
	func delete(objectId: String) async throws {}
	func setStarred(objectId: String, starred: Bool) async throws {}
	func postComment(objectId: String, content: String, parentEventId: Int?, idempotencyKey: String) async throws -> ObjectEvent {
		ObjectEvent(id: 9, actorId: "me", action: "commented")
	}
	func actors() async throws -> [ActorRef] { sampleActors }
	func schema(workspaceId: String) async throws -> ObjectsSchema { .fallback }
}

// MARK: - Rendering

private func outputDirectory() -> URL {
	let path = ProcessInfo.processInfo.environment["OBJECTS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory()
	let url = URL(fileURLWithPath: path, isDirectory: true)
	try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
	return url
}

@MainActor
@discardableResult
private func snapshot<V: View>(
	_ name: String, width: CGFloat, dark: Bool, @ViewBuilder _ content: () -> V
) throws -> URL {
	let view = content()
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: view)
	renderer.scale = 2
	let image = try #require(renderer.cgImage)
	let url = outputDirectory().appendingPathComponent("objects-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
	#expect(image.width > 0 && image.height > 0)
	return url
}

private let sizes: [(CGFloat, Bool)] = [(402, false), (402, true), (820, false), (820, true)]

@MainActor
@Suite("Objects snapshots")
struct ObjectsSnapshotTests {
	@Test("list renders grouped rows at phone and tablet widths, light and dark")
	func list() async throws {
		let remote = StubRemote()
		let directory = ObjectsDirectory(remote: remote, actors: sampleActors)
		let store = ObjectsStore(remote: remote, directory: directory)
		await store.load()
		for (width, dark) in sizes {
			try snapshot("list", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					ForEach(store.groups) { group in
						ObjectGroupHeader(group: group)
						VStack(spacing: 0) {
							ForEach(group.objects) { object in
								ObjectRow(
									object: object, typeName: directory.typeName(object.type),
									ownerName: directory.name(for: object.driverId))
									.padding(.horizontal, MaskinSpace.s9)
									.padding(.vertical, MaskinSpace.s4)
							}
						}
						.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
					}
				}
				.padding(MaskinSpace.s9)
			}
		}
	}

	@Test("detail renders header, relationships and the attributed timeline")
	func detail() async throws {
		let remote = StubRemote()
		let directory = ObjectsDirectory(remote: remote, actors: sampleActors)
		let store = ObjectDetailStore(objectId: "t1", remote: remote, directory: directory, currentActorId: "me", preload: detailObject)
		await store.load()
		await store.postComment("Looks good, merging after CI.")
		for (width, dark) in sizes {
			try snapshot("detail", width: width, dark: dark) {
				ObjectDetailContent(store: store, onOpenObject: { _ in }) {
					Text("Decision slot").maskinText(.subhead).padding(MaskinSpace.s9)
						.frame(maxWidth: .infinity)
						.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero))
				}
				.padding(MaskinSpace.s9)
			}
		}
	}

	@Test("empty and loading states render")
	func emptyStates() throws {
		for (width, dark) in sizes {
			try snapshot("empty", width: width, dark: dark) {
				VStack(spacing: MaskinSpace.s9) {
					EmptyState(
						symbol: "square.stack.3d.up", title: "No objects yet",
						message: "Insights, bets and tasks created by you and your agents show up here."
					) {
						Button("New object") {}.buttonStyle(.primaryAction)
					}
					LoadingSkeleton(rows: 2)
				}
				.padding(MaskinSpace.s9)
			}
		}
	}

	@Test("offline failure with a not-sent comment renders")
	func failedComment() async throws {
		let remote = StubRemote()
		let directory = ObjectsDirectory(remote: remote, actors: sampleActors)
		let store = ObjectDetailStore(objectId: "t1", remote: remote, directory: directory, currentActorId: "me")
		try snapshot("failed-comment", width: 402, dark: false) {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				TimelineRow(
					item: TimelineItem(id: "l", kind: .comment("Can someone take this?"), actorId: "me", date: ago(1), delivery: .failed, eventId: nil),
					name: "You", isAgent: false)
				TimelineRow(
					item: TimelineItem(id: "s", kind: .comment("Sending…"), actorId: "me", date: ago(0), delivery: .sending, eventId: nil),
					name: "You", isAgent: false)
			}
			.padding(MaskinSpace.s9)
		}
		_ = store
	}
}
