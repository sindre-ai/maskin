import Foundation
import Observation

/// One Drive folder an agent watches (`GET /api/integrations/google-drive/watched-folders`).
public struct DriveWatch: Identifiable, Sendable, Equatable {
	public var id: String { "\(integrationId):\(folderId)" }
	public var folderId: String
	public var name: String
	public var path: String?
	public var lastFiredAt: Date?
	public var integrationId: String
	public var account: String?
	public var triggerNames: [String]

	public init(
		folderId: String, name: String, path: String? = nil, lastFiredAt: Date? = nil,
		integrationId: String, account: String? = nil, triggerNames: [String] = []
	) {
		self.folderId = folderId
		self.name = name
		self.path = path
		self.lastFiredAt = lastFiredAt
		self.integrationId = integrationId
		self.account = account
		self.triggerNames = triggerNames
	}

	/// The stored path is the folder's ancestors; the folder's own name closes it unless it already does.
	public var displayPath: String {
		guard let path, !path.isEmpty else { return name }
		var trimmed = path
		while trimmed.hasSuffix("/") { trimmed.removeLast() }
		return trimmed.split(separator: "/").last.map(String.init) == name ? trimmed : "\(trimmed)/\(name)"
	}
}

public protocol DriveWatchesAPI: Sendable {
	func list() async throws -> [DriveWatch]
	func stop(folderId: String, idempotencyKey: String) async throws
}

/// The Folder watches group on the Google Drive page: read and stop. Adding a watch stays with an
/// agent's trigger settings, as on the web.
@MainActor
@Observable
public final class DriveWatchesStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading
		case loaded([DriveWatch])
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	public private(set) var stoppingIDs: Set<String> = []
	public private(set) var actionError: String?
	public let canManage: Bool
	@ObservationIgnored private let api: any DriveWatchesAPI

	public init(api: any DriveWatchesAPI, canManage: Bool) {
		self.api = api
		self.canManage = canManage
	}

	public var watches: [DriveWatch] {
		if case .loaded(let list) = phase { return list }
		return []
	}

	public func load() async {
		if case .idle = phase { phase = .loading }
		if case .failed = phase { phase = .loading }
		do { phase = .loaded(try await api.list()) } catch {
			if case .loaded = phase { return }
			phase = .failed((error as? SettingsError)?.message ?? "Couldn't load folder watches.")
		}
	}

	/// Stops one watch. The row leaves the list only once the server confirms.
	public func stop(_ watch: DriveWatch) async {
		guard canManage, !stoppingIDs.contains(watch.id) else { return }
		stoppingIDs.insert(watch.id)
		actionError = nil
		defer { stoppingIDs.remove(watch.id) }
		do {
			try await api.stop(folderId: watch.folderId, idempotencyKey: UUID().uuidString)
			// The server drops the folder from every Drive connection that held it.
			phase = .loaded(watches.filter { $0.folderId != watch.folderId })
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't stop that watch."
		}
	}
}

public struct APIDriveWatchesSource: DriveWatchesAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	private struct Wire: Decodable {
		struct Trigger: Decodable { var name: String }
		var folderId: String
		var name: String
		var path: String?
		var lastFiredAt: String?
		var integrationId: String
		var account: String?
		var triggers: [Trigger]
	}

	public func list() async throws -> [DriveWatch] {
		let (data, status) = try await http.send("GET", "api/integrations/google-drive/watched-folders")
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't load folder watches.")
		}
		let iso = ISO8601DateFormatter()
		iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		let plain = ISO8601DateFormatter()
		return try SettingsHTTP.decode([Wire].self, data).map { wire in
			DriveWatch(
				folderId: wire.folderId, name: wire.name, path: wire.path,
				lastFiredAt: wire.lastFiredAt.flatMap { iso.date(from: $0) ?? plain.date(from: $0) },
				integrationId: wire.integrationId, account: wire.account, triggerNames: wire.triggers.map(\.name))
		}
	}

	public func stop(folderId: String, idempotencyKey: String) async throws {
		// Drive folder ids are URL-safe (the server accepts only letters, digits, "_" and "-").
		let (data, status) = try await http.send(
			"DELETE", "api/integrations/google-drive/watched-folders/\(folderId)", key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(
				status: status, data: data,
				fallback: status == 404 ? "That folder is no longer watched." : "Couldn't stop that watch.")
		}
	}
}
