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
	ActorRef(id: "strategist", name: "Strategist", isAgent: true),
]

private let objects = [
	WorkObject(
		id: "t1", type: "task", title: "Wire up SSE reconnect with exponential backoff and jitter",
		content: "Reconnect with backoff.", status: "in_progress", driverId: "forge", updatedAt: ago(5),
		isStarred: true, unreadCount: 2, activeActivity: "Reading EventHub.swift"),
	WorkObject(id: "t3", type: "task", title: "Design empty states", status: "in_progress", driverId: "me", updatedAt: ago(90)),
	WorkObject(id: "t4", type: "task", title: "Pricing page copy", status: "in_review", driverId: "strategist", updatedAt: ago(12)),
	WorkObject(id: "b1", type: "bet", title: "Native iOS app", status: "active", driverId: "sigrid", updatedAt: ago(30)),
	WorkObject(id: "b2", type: "bet", title: "Retry policy v2", status: "succeeded", driverId: "forge", updatedAt: ago(600)),
	WorkObject(id: "i1", type: "insight", title: "Users want push notifications", status: "new", updatedAt: ago(120)),
]

private let asks = [
	ObjectAsk(
		objectId: "t4", askedBy: "Strategist", text: "Post text only, or with the pricing table?",
		parentEventId: 9, latestEventId: 12,
		options: [DecisionOption(label: "Text only", recommended: true), DecisionOption(label: "Hold")]),
]

private struct StubRemote: ObjectsRemote {
	func list(_ query: ObjectsQuery) async throws -> [WorkObject] {
		var result = objects
		if let type = query.type { result = result.filter { $0.type == type } }
		if let status = query.status { result = result.filter { $0.status == status } }
		return result
	}
	func graph(objectId: String) async throws -> ObjectGraph {
		ObjectGraph(object: objects[0], links: [], events: [])
	}
	func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject { objects[0] }
	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject {
		patch.applied(to: objects.first { $0.id == objectId } ?? objects[0])
	}
	func delete(objectId: String) async throws {}
	func setStarred(objectId: String, starred: Bool) async throws {}
	func postComment(
		objectId: String, content: String, mentions: [String], refs: [String],
		attachmentFileIds: [String], parentEventId: Int?, idempotencyKey: String
	) async throws -> ObjectEvent {
		ObjectEvent(id: 9, actorId: "me", action: "commented")
	}
	func createRelationship(
		sourceId: String, sourceType: String, targetId: String, targetType: String, type: String,
		idempotencyKey: String
	) async throws -> ObjectLink {
		ObjectLink(id: "r", relation: type, isOutgoing: true, otherId: targetId, otherType: targetType, otherTitle: "Untitled")
	}
	func actors() async throws -> [ActorRef] { sampleActors }
	func board(_ query: ObjectsBoardQuery) async throws -> [ObjectsBoardColumn] {
		let ofType = objects.filter { $0.type == query.type }
		return ObjectsSchema.fallback.statuses(for: query.type).map { status in
			let inColumn = ofType.filter { $0.status == status }
			return ObjectsBoardColumn(id: "status:\(status)", value: status, total: inColumn.count, objects: inColumn)
		}
	}
	func schema(workspaceId: String) async throws -> ObjectsSchema { .fallback }
}

@MainActor
private func makeStore() async -> ObjectsStore {
	let remote = StubRemote()
	let directory = ObjectsDirectory(remote: remote, actors: sampleActors)
	let store = ObjectsStore(
		remote: remote, directory: directory, displayStorage: InMemoryObjectsDisplayStorage(),
		defaults: UserDefaults(suiteName: "ObjectsSnapshotTests.\(UUID().uuidString)")!)
	store.bindWorkspace("ws-snap")
	await store.load()
	store.applyAsks(asks)
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

/// A group as the list draws it: foldable header, one inset card, hairline separators.
@MainActor
private func groupCard(_ group: ObjectGroup, store: ObjectsStore) -> some View {
	VStack(alignment: .leading, spacing: 0) {
		ObjectGroupHeader(group: group, collapsed: false) {}
			.padding(.horizontal, MaskinSpace.s11 - MaskinSpace.s4)
		VStack(spacing: 0) {
			ForEach(Array(group.objects.enumerated()), id: \.element.id) { index, object in
				if index > 0 {
					Divider().overlay(MaskinSurface.separator).padding(.leading, MaskinSpace.s14 + MaskinSpace.s1)
				}
				ObjectRow(
					object: object, typeName: store.directory.typeName(object.type), showsGlyph: store.mixesTypes,
					ask: store.ask(for: object.id), ownerName: store.directory.name(for: object.driverId),
					ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true)
					.padding(.horizontal, MaskinSpace.s8)
					.padding(.vertical, MaskinSpace.s7)
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.padding(.horizontal, MaskinSpace.s9)
	}
}

@MainActor
@Suite("Objects snapshots")
struct ObjectsSnapshotTests {
	@Test("the list renders title, tabs and status groups with mixed-type rows, light and dark")
	func list() async throws {
		let store = await makeStore()
		for (width, dark) in sizes {
			try snapshot("list", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(spacing: MaskinSpace.s3) {
						Text(store.title).maskinText(.largeTitle).foregroundStyle(MaskinColor.ink)
						Image(systemName: "chevron.down")
							.maskinSymbol(MaskinFontSize.t16, weight: .bold)
							.foregroundStyle(MaskinColor.ink4)
					}
					.padding(.horizontal, MaskinSpace.s11)
					ObjectTypeTabs(tabs: ObjectTypeTab.tabs(for: store), selected: store.scope) { _ in }
					ForEach(store.groups) { group in
						groupCard(group, store: store)
					}
				}
				.padding(.vertical, MaskinSpace.s9)
			}
		}
		#expect(store.groups.map(\.title).contains("Tasks · In review"))
		#expect(ObjectTypeTab.tabs(for: store).map(\.label) == ["Needs you", "All", "Favourites", "Bets", "Insights", "Tasks"])
		// t1 is starred, so the Favourites tab shows. t1 is unread and t4 carries the ask (and is in review): two objects need the reader.
		#expect(ObjectTypeTab.tabs(for: store).first?.count == "2")
	}

	@Test("a single-type list drops the glyph and the Needs you tab reads as an ink pill")
	func singleType() async throws {
		let store = await makeStore()
		await store.setScope(.type("task"))
		#expect(!store.mixesTypes)
		for (width, dark) in sizes {
			try snapshot("tasks", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					ObjectTypeTabs(tabs: ObjectTypeTab.tabs(for: store), selected: .needsYou) { _ in }
					ForEach(store.groups) { group in
						groupCard(group, store: store)
					}
				}
				.padding(.vertical, MaskinSpace.s9)
			}
		}
	}

	@Test("rows: needs you with ask line, working agent with ring and bars, unseen dot, fewer properties")
	func rows() throws {
		for (width, dark) in [(402, false), (402, true)] as [(CGFloat, Bool)] {
			try snapshot("rows", width: width, dark: dark) {
				VStack(spacing: MaskinSpace.s4) {
					ObjectRow(object: objects[2], typeName: "Task", ask: asks[0], ownerName: "Strategist", ownerIsAgent: true)
					ObjectRow(object: objects[0], typeName: "Task", ownerName: "Forge", ownerIsAgent: true)
					ObjectRow(object: objects[4], typeName: "Bet", showsGlyph: false, ownerName: "Forge", ownerIsAgent: true)
					ObjectRow(object: objects[5], typeName: "Insight", ownerName: nil)
					ObjectRow(object: objects[3], typeName: "Bet", ownerName: "Sigrid Larsen", showsDriver: false, showsUpdated: false)
				}
				.padding(MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
				.padding(MaskinSpace.s9)
			}
		}
	}

	@Test("the Go to sheet renders views, the type grid with a Patina badge, and saved views")
	func goTo() async throws {
		let store = await makeStore()
		store.saveCurrentView(named: "Doing now")
		await store.setScope(.type("bet"))
		for (width, dark) in sizes {
			try snapshot("goto", width: width, dark: dark) {
				GoToContent(
					current: store.scope, needsYou: store.needsYouCount, total: store.totalCountLabel,
					favourites: store.favouritesCount, types: store.typeSummaries,
					savedViews: store.savedViews.views.map { ($0, store.count(of: $0)) })
			}
		}
		#expect(store.typeSummaries.first { $0.id == "task" }?.needsYou == 2)
	}

	@Test("board columns render cards with the row's content and an empty drop target")
	func board() async throws {
		let store = await makeStore()
		await store.setScope(.type("task"))
		let remote = StubRemote()
		let columns = try await remote.board(ObjectsBoardQuery(type: "task"))
		for (width, dark) in [(820, false), (820, true)] as [(CGFloat, Bool)] {
			try snapshot("board", width: width, dark: dark) {
				HStack(alignment: .top, spacing: MaskinSpace.s5) {
					ForEach(columns.filter { ["in_progress", "in_review", "done"].contains($0.value) }) { column in
						ObjectsBoardColumnView(column: column, cards: column.objects, count: column.total, store: store)
					}
				}
				.padding(MaskinSpace.s9)
			}
		}
	}

	@Test("group headers, working bars, the driver slot and the empty states render")
	func chrome() throws {
		for (width, dark) in [(402, false), (402, true)] as [(CGFloat, Bool)] {
			try snapshot("chrome", width: width, dark: dark) {
				VStack(alignment: .leading, spacing: MaskinSpace.s9) {
					HStack(spacing: MaskinSpace.s7) {
						ObjectWorkingBars()
						ObjectDriverAvatar(name: "Forge", isAgent: true, seed: "forge", working: true)
						ObjectDriverAvatar(name: nil, isAgent: false, seed: nil)
					}
					ObjectGroupHeader(
						group: ObjectGroup(id: "done", title: "Done", objects: [objects[4]], status: "done"),
						collapsed: true) {}
					ObjectGroupHeader(
						group: ObjectGroup(id: "bet", title: "Bets", objects: [objects[3]], isType: true, type: "bet")) {}
					EmptyState(
						symbol: "checkmark.circle", title: "Nothing needs you",
						message: "Agents are working. Asks for you land here."
					) {
						Button("See all objects") {}.buttonStyle(.secondaryAction)
					}
					LoadingSkeleton(rows: 2)
				}
				.padding(MaskinSpace.s9)
			}
		}
	}
}
