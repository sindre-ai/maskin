import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production source for the marketplace store. The generated client's operation names stay
/// inside this file.
public struct APIMarketplaceSource: MarketplaceAPI {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func catalog() async throws -> [MarketplaceLoop] {
		let output = try await client.get_sol_api_sol_marketplace_sol_loops(.init())
		guard case .ok(let ok) = output else {
			throw AutomationError("Couldn't load the marketplace.")
		}
		return try Self.decode(CatalogWire.self, from: ok.body.json).loops.map(\.model)
	}

	public func detail(loopID: String) async throws -> MarketplaceLoopDetail {
		let output = try await client.get_sol_api_sol_marketplace_sol_loops_sol__lcub_id_rcub_(
			.init(path: .init(id: loopID)))
		switch output {
		case .ok(let ok):
			let wire = try Self.decode(DetailWire.self, from: ok.body.json)
			return MarketplaceLoopDetail(loop: wire.loop.model, items: wire.items.map(\.model))
		case .notFound: throw AutomationError("This loop is no longer in the marketplace.")
		default: throw AutomationError("Couldn't load this loop.")
		}
	}

	public func installs() async throws -> [InstalledLoop] {
		let output = try await client.get_sol_api_sol_installed_hyphen_loops(
			.init(query: .init(workspaceId: workspaceID)))
		guard case .ok(let ok) = output else { throw AutomationError("Couldn't load installed loops.") }
		return try Self.decode(InstallsWire.self, from: ok.body.json).installs.map(\.model)
	}

	public func install(loopID: String, idempotencyKey: String) async throws -> InstalledLoop {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_installed_hyphen_loops(
				.init(
					body: .json(.init(loopId: loopID, workspaceId: workspaceID, source: .detail))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return InstalledLoop(
				id: row.id, sourceLoopID: row.sourceLoopId, objectID: row.objectId,
				installedVersion: row.installedVersion, availableVersion: row.installedVersion,
				isForked: row.forkedAt != nil)
		case .conflict: throw AutomationError("This loop is already installed.")
		case .forbidden: throw AutomationError("You don't have permission to install loops here.")
		case .notFound: throw AutomationError("This loop is no longer in the marketplace.")
		default: throw AutomationError("The install failed. Try again in a moment.")
		}
	}

	public func fork(installID: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_installed_hyphen_loops_sol__lcub_id_rcub__sol_fork(
				.init(path: .init(id: installID)))
		}
		switch output {
		case .ok: return
		case .conflict: throw AutomationError("This loop is already a fork.")
		case .notFound: throw AutomationError("This install no longer exists.")
		default: throw AutomationError("Couldn't fork this loop.")
		}
	}

	public func uninstall(installID: String, keepProvisionedItems: Bool, idempotencyKey: String)
		async throws
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.delete_sol_api_sol_installed_hyphen_loops_sol__lcub_id_rcub_(
				.init(
					path: .init(id: installID),
					body: .json(.init(keepProvisionedItems: keepProvisionedItems))))
		}
		switch output {
		case .ok: return
		case .notFound: throw AutomationError("This install no longer exists.")
		default: throw AutomationError("Couldn't remove this loop.")
		}
	}

	// MARK: Wire

	private struct LoopWire: Decodable {
		var id: String
		var name: String
		var description: String
		var version: String
		var use_case: String?
		var item_types: [String]
		var updated_at: String?

		var model: MarketplaceLoop {
			MarketplaceLoop(
				id: id, name: name, summary: description, version: version, useCase: use_case,
				itemKinds: item_types.map(MarketplaceItemKind.init(wire:)),
				updatedAt: AutomationDates.parse(updated_at))
		}
	}

	private struct CatalogWire: Decodable { var loops: [LoopWire] }

	private struct ItemWire: Decodable {
		var id: String
		var item_type: String
		var item_snapshot: JSONValue?

		var model: MarketplaceItem {
			let kind = MarketplaceItemKind(wire: item_type)
			var name: String?
			var summary: String?
			if case .object(let fields)? = item_snapshot {
				if case .string(let value)? = fields["name"] { name = value }
				if case .string(let value)? = fields["description"] { summary = value }
			}
			let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			return MarketplaceItem(
				id: id, kind: kind, name: trimmed.isEmpty ? kind.singularLabel : trimmed,
				summary: summary?.isEmpty == true ? nil : summary)
		}
	}

	private struct DetailWire: Decodable {
		var loop: LoopWire
		var items: [ItemWire]
	}

	private struct InstallsWire: Decodable {
		struct Row: Decodable {
			var id: String
			var sourceLoopId: String
			var objectId: String?
			var installedVersion: String
			var availableVersion: String
			var hasUpdate: Bool
			var forkedAt: String?
			var loopName: String

			var model: InstalledLoop {
				InstalledLoop(
					id: id, sourceLoopID: sourceLoopId, objectID: objectId,
					installedVersion: installedVersion, availableVersion: availableVersion,
					hasUpdate: hasUpdate, isForked: forkedAt != nil, loopName: loopName)
			}
		}
		var installs: [Row]
	}

	private static func decode<T: Decodable>(_ type: T.Type, from value: some Encodable) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}
}
