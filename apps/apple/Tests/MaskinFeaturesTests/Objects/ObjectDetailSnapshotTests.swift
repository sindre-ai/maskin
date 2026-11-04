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

/// A fixed Wednesday noon so day labels and "Today" times never drift between runs.
private let now = Date(timeIntervalSince1970: 1_791_374_400)
private func ago(minutes: Int) -> Date { now.addingTimeInterval(-Double(minutes * 60)) }

private let sampleActors = [
	ActorRef(id: "me", name: "Alex Preview", isAgent: false),
	ActorRef(id: "sigrid", name: "Sigrid Larsen", isAgent: false),
	ActorRef(id: "forge", name: "Forge", isAgent: true),
]

private let longDescription = """
	# Why this matters

	The stream drops on every cellular handoff, and the agent loses the thread of what it was doing. Reconnecting without a budget just hammers the server and drains the battery, so this task sets the rules for coming back.

	## What to build

	- Reconnect with **exponential backoff** starting at 500 ms and capped at 30 s
	- Resume from `Last-Event-ID` so nothing in between is lost
	- Surface a quiet offline banner instead of an alert

	## Steps

	1. Wrap the SSE client in a retry loop with jitter
	2. Persist the last event id on every message
	3. Replay the gap on reconnect and dedupe by id
	4. Add a two-minute give-up that shows the banner

	Keep the banner out of the way of the composer. The design notes have the retry budget table and the copy for each state.
	"""

private let detailObject = WorkObject(
	id: "t1", type: "task", title: "Wire up SSE reconnect with exponential backoff and jitter",
	content: longDescription, status: "in_progress",
	metadata: ["effort": "3", "area": "networking", "priority": "high", "due": "2026-10-14"],
	driverId: "forge", updatedAt: ago(minutes: 13 * 60), isStarred: true, activeActivity: "Reading EventHub.swift")

private let shortObject = WorkObject(
	id: "t2", type: "bet", title: "Native iOS app", content: "Ship a SwiftUI client.", status: "active",
	driverId: "sigrid", updatedAt: ago(minutes: 30))

private let longComment = """
	Reconnect is flaky on cellular. I'm adding **backoff** with jitter and a resume from `Last-Event-ID`.

	What I found so far:
	- The server closes idle streams after 55 s, so the client must send a heartbeat or expect a reconnect once a minute.
	- The gap replay works but double-delivers when the id is missing from the first frame.
	- Battery impact is fine below ten reconnects an hour.

	I'll report back once the dedupe is in and the banner copy is wired. @Sigrid Larsen can you check the copy?
	"""

private struct DetailRemote: ObjectsRemote {
	var object: WorkObject = detailObject

	func list(_ query: ObjectsQuery) async throws -> [WorkObject] { [detailObject, shortObject] }
	func graph(objectId: String) async throws -> ObjectGraph {
		if objectId == "i1" {
			return ObjectGraph(
				object: WorkObject(id: "i1", type: "insight", title: "Users want push notifications", status: "new"),
				links: [], events: [])
		}
		return ObjectGraph(
			object: object,
			links: [
				ObjectLink(id: "r1", relation: "blocks", isOutgoing: true, otherId: "t9", otherType: "task", otherTitle: "Write migration for devices", otherStatus: "todo"),
				ObjectLink(id: "r2", relation: "breaks_into", isOutgoing: false, otherId: "b1", otherType: "bet", otherTitle: "Native iOS app", otherStatus: "active"),
				ObjectLink(id: "r3", relation: "informs", isOutgoing: false, otherId: "i1", otherType: "insight", otherTitle: "Untitled", otherStatus: "new"),
				ObjectLink(id: "r4", relation: "relates_to", isOutgoing: false, otherId: "l1", otherType: "loop", otherTitle: "Mobile launch", otherStatus: "active"),
			],
			events: [
				ObjectEvent(id: 1, actorId: "sigrid", action: "created", createdAt: ago(minutes: 9 * 24 * 60), summary: "created task"),
				ObjectEvent(id: 2, actorId: "me", action: "status_changed", createdAt: ago(minutes: 3 * 24 * 60), summary: "moved status from todo to in progress"),
				ObjectEvent(id: 3, actorId: "forge", action: "commented", data: .object(["content": .string(longComment)]), createdAt: ago(minutes: 26 * 60)),
				ObjectEvent(id: 4, actorId: "sigrid", action: "commented", data: .object(["content": .string("Copy looks right, go ahead."), "parentEventId": .number(3)]), createdAt: ago(minutes: 20 * 60)),
				ObjectEvent(id: 5, actorId: "me", action: "commented", data: .object(["content": .string("Great, ship it behind the flag.")]), createdAt: ago(minutes: 50)),
				ObjectEvent(id: 6, actorId: "forge", action: "session_started", createdAt: ago(minutes: 12), summary: "started working"),
			])
	}
	func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject { object }
	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject { object }
	func delete(objectId: String) async throws {}
	func setStarred(objectId: String, starred: Bool) async throws {}
	func postComment(
		objectId: String, content: String, mentions: [String], refs: [String],
		attachmentFileIds: [String], parentEventId: Int?, idempotencyKey: String
	) async throws -> ObjectEvent {
		ObjectEvent(id: 9, actorId: "me", action: "commented", data: .object(["content": .string(content)]), createdAt: now)
	}
	func createRelationship(
		sourceId: String, sourceType: String, targetId: String, targetType: String, type: String,
		idempotencyKey: String
	) async throws -> ObjectLink {
		ObjectLink(id: "r9", relation: type, isOutgoing: true, otherId: targetId, otherType: targetType, otherTitle: "Linked")
	}
	func actors() async throws -> [ActorRef] { sampleActors }
	func schema(workspaceId: String) async throws -> ObjectsSchema { .fallback }
}

@MainActor
private func makeStore(_ object: WorkObject = detailObject) async -> ObjectDetailStore {
	let remote = DetailRemote(object: object)
	let directory = ObjectsDirectory(remote: remote, actors: sampleActors)
	let suite = "ObjectDetailSnapshotTests.\(UUID().uuidString)"
	let store = ObjectDetailStore(
		objectId: object.id, remote: remote, directory: directory, currentActorId: "me", preload: object,
		defaults: UserDefaults(suiteName: suite)!)
	await store.load()
	return store
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
) throws -> CGImage {
	let view = content()
		.padding(MaskinSpace.s9)
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: view)
	renderer.scale = 2
	let image = try #require(renderer.cgImage)
	let url = outputDirectory().appendingPathComponent("object-detail-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
	#expect(image.width > 0 && image.height > 0)
	return image
}

private let sizes: [(CGFloat, Bool)] = [(402, false), (402, true), (820, false), (820, true)]

@MainActor
@Suite("Object detail snapshots")
struct ObjectDetailSnapshotTests {
	@Test("header: glyph and type, full title, status · driver · priority · due chips, working line, updated")
	func header() async throws {
		let store = await makeStore()
		for (width, dark) in sizes {
			try snapshot("header", width: width, dark: dark) {
				ObjectDetailContent(store: store, part: .header, interactiveChips: false) { EmptyView() }
			}
		}
		// A type with no priority or due set shows the Add chip instead and no working line.
		let bare = await makeStore(shortObject)
		try snapshot("header-bare", width: 402, dark: false) {
			ObjectDetailContent(store: bare, part: .header, interactiveChips: false) { EmptyView() }
		}
	}

	@Test("overview: ask slot, folded description with Read all, outcomes, properties, Latest row")
	func overviewCollapsed() async throws {
		let store = await makeStore()
		#expect(DescriptionCollapse.collapses(longDescription))
		for (width, dark) in sizes {
			let image = try snapshot("overview-collapsed", width: width, dark: dark) {
				ObjectDetailContent(store: store, part: .overview, now: now) {
					Text("Ask card").maskinText(.subhead).padding(MaskinSpace.s9)
						.frame(maxWidth: .infinity)
						.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief))
				}
			}
			_ = image
		}
	}

	@Test("overview: the description expanded is taller than folded and never truncates a line")
	func overviewExpanded() async throws {
		let store = await makeStore()
		let folded = try snapshot("description-folded", width: 402, dark: false) {
			CollapsibleDescription(content: longDescription)
		}
		var expandedHeight = 0
		for (width, dark) in sizes {
			let image = try snapshot("description-expanded", width: width, dark: dark) {
				CollapsibleDescription(content: longDescription, initiallyExpanded: true)
			}
			if width == 402, !dark { expandedHeight = image.height }
		}
		#expect(expandedHeight > folded.height)
		// Folded: 240pt of content plus the Read all button, at 2x.
		#expect(folded.height <= Int((CollapsibleDescription.collapsedHeight + MaskinSpace.touchMin + MaskinSpace.s9 * 2) * 2) + 4)
		_ = store
	}

	@Test("related: In flow first, glyph tiles, resolved titles, status words, Link an object")
	func related() async throws {
		let store = await makeStore()
		try await waitUntil { store.linkTitles["i1"] != nil }
		#expect(store.relatedGroups.map(\.label) == ["In flow", "Blocking", "Belongs to", "Based on"])
		for (width, dark) in sizes {
			try snapshot("related", width: width, dark: dark) {
				ObjectDetailContent(store: store, part: .related, onOpenObject: { _ in }) { EmptyView() }
			}
		}
	}

	@Test("activity: day groups, a long comment as a bubble with a nested reply, short remarks and events as quiet lines")
	func activity() async throws {
		let store = await makeStore()
		let days = ActivityGrouping.days(store.timeline, now: now)
		#expect(days.first?.label == "Today")
		#expect(days.count == 4)
		#expect(days.first?.entries.first?.kind == .event)
		#expect(days.flatMap(\.entries).first { $0.item.eventId == 3 }?.replies.count == 1)
		for (width, dark) in sizes {
			try snapshot("activity", width: width, dark: dark) {
				ObjectDetailContent(store: store, part: .activity, onOpenObject: { _ in }, onReply: { _ in }, now: now) { EmptyView() }
			}
		}
	}

	@Test("rows: the Latest row and quiet events, with and without a time and a failed send")
	func chrome() throws {
		for (width, dark) in [(402.0, false), (402.0, true)] {
			try snapshot("chrome", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					LatestRow(who: "Forge", what: "started working", date: ago(minutes: 12)) {}
					QuietEventRow(who: "You", what: "Great, ship it behind the flag.", time: "11:10")
					QuietEventRow(who: "You", what: "Can someone take this?", time: nil, delivery: .failed)
				}
			}
		}
	}

	@Test("a failed and a sending comment keep their footers")
	func delivery() throws {
		try snapshot("delivery", width: 402, dark: false) {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				TimelineRow(
					item: TimelineItem(id: "l", kind: .comment(longComment), actorId: "me", date: ago(minutes: 1), delivery: .failed, eventId: nil),
					name: "You", isAgent: false)
				TimelineRow(
					item: TimelineItem(id: "s", kind: .comment(longComment), actorId: "me", date: now, delivery: .sending, eventId: nil),
					name: "You", isAgent: false, time: "12:00")
			}
		}
	}
}

/// Polls until `condition` holds or the budget (see `PollBudget`) is spent.
private func waitUntil(timeout: Duration = .seconds(10), _ condition: @MainActor () -> Bool) async throws {
	var budget = PollBudget(timeout)
	repeat {
		if await condition() { return }
		try await Task.sleep(for: .milliseconds(20))
	} while budget.spend()
	Issue.record("timed out waiting")
}
