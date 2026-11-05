import MaskinAPI
import MaskinCore
import SwiftUI

/// What the composer's `/` picker reads and writes: recent items, a title search, and creating a
/// task, bet or insight. One per composer host; the remote is the same one the Items screen uses.
@MainActor
@Observable
public final class SlashSource {
	public let workspaceID: String
	private let remote: any ObjectsRemote
	private(set) var recent: [SlashItem] = []
	private(set) var found: [SlashItem] = []
	@ObservationIgnored private var schema: ObjectsSchema?
	@ObservationIgnored private var loadedRecent = false

	init(remote: any ObjectsRemote, workspaceID: String) {
		self.remote = remote
		self.workspaceID = workspaceID
	}

	private func label(_ type: String) -> String {
		(schema ?? .fallback).displayName(for: type)
	}

	private func item(_ object: WorkObject) -> SlashItem {
		SlashItem(id: object.id, title: object.displayTitle, typeLabel: label(object.type))
	}

	/// Loads the latest items once, then a search per query. A failed read leaves the list as it was.
	func refresh(query: String) async {
		if schema == nil { schema = try? await remote.schema(workspaceId: workspaceID) }
		let trimmed = query.trimmingCharacters(in: .whitespaces)
		if trimmed.isEmpty {
			guard !loadedRecent else { return }
			if let list = try? await remote.list(ObjectsQuery(limit: 20, sort: .updated)) {
				recent = Array(ObjectsSorter.sorted(list, by: .updated).map(item))
				loadedRecent = true
			}
		} else {
			try? await Task.sleep(for: .milliseconds(200))
			if Task.isCancelled { return }
			if let list = try? await remote.list(ObjectsQuery(search: trimmed, limit: 10, sort: .updated)) {
				found = list.map(item)
			}
		}
	}

	func rows(query: String) -> [SlashItem] {
		query.trimmingCharacters(in: .whitespaces).isEmpty ? SlashReference.matches(recent, query: "") : found
	}

	/// Creates the item and returns the link to put in the message; nil when the server refused.
	func create(_ type: SlashCreateType, title: String) async -> String? {
		if schema == nil { schema = try? await remote.schema(workspaceId: workspaceID) }
		let statuses = (schema ?? .fallback).statuses(for: type.rawValue)
		let name = title.trimmingCharacters(in: .whitespaces)
		let draft = ObjectDraft(
			type: type.rawValue, title: name.isEmpty ? type.untitled : name, status: statuses.first ?? "new")
		guard let made = try? await remote.create(draft, idempotencyKey: IdempotencyKey.make()) else { return nil }
		recent.insert(item(made), at: 0)
		return SlashReference.markdown(title: made.displayTitle, workspaceID: workspaceID, objectID: made.id)
	}
}

/// One source per workspace, so the recent list is not fetched again for every chat opened.
@MainActor
enum SlashSources {
	private static var cache: [String: SlashSource] = [:]

	static func source(for environment: AppEnvironment, workspaceID: String) -> SlashSource {
		if let held = cache[workspaceID] { return held }
		let remote = APIObjectsRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider,
			baseURL: environment.baseURL, clientSource: environment.clientSource)
		let made = SlashSource(remote: remote, workspaceID: workspaceID)
		cache[workspaceID] = made
		return made
	}
}
