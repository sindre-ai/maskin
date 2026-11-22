import Foundation
import Observation

/// One watched Drive folder (`GET /api/integrations/google-drive/watched-folders`). Optional
/// fields are nil when the watch has no stored value for them; a part with no source is left out.
public struct DriveWatch: Identifiable, Sendable, Equatable {
	public var id: String { "\(integrationId):\(folderId)" }
	public var folderId: String
	public var name: String
	public var path: String?
	public var lastFiredAt: Date?
	public var integrationId: String
	/// Google account (email) of the Drive connection the watch lives on.
	public var account: String?
	/// Enabled triggers whose filter names this folder.
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

	/// The path a watch is listed under. The stored path is its ancestors; the folder's own name
	/// closes it unless the path already does.
	public var displayPath: String {
		guard let path, !path.isEmpty else { return name }
		var trimmed = path
		while trimmed.hasSuffix("/") { trimmed.removeLast() }
		let last = trimmed.split(separator: "/").last.map(String.init)
		return last == name ? trimmed : "\(trimmed)/\(name)"
	}

	/// The person the watch's Google account belongs to, as the web shows them without a member
	/// match: the part of the address before the "@".
	public var humanName: String? {
		guard let account, !account.isEmpty else { return nil }
		return account.split(separator: "@").first.map(String.init) ?? account
	}

	/// Longest path shown in full before the leading folders are dropped.
	public static let pathMaxChars = 60

	/// Drops leading folders, never cuts a folder name: "…/Clients/Acme/Briefs". The last folder
	/// always stays whole, however long, so the result can exceed `maxChars`.
	public static func truncatePath(_ path: String, maxChars: Int = pathMaxChars) -> String {
		if path.count <= maxChars { return path }
		let segments = path.split(separator: "/").map(String.init)
		var kept: [String] = []
		var length = "…/".count
		for segment in segments.reversed() {
			let next = length + segment.count + (kept.isEmpty ? 0 : 1)
			if !kept.isEmpty && next > maxChars { break }
			kept.insert(segment, at: 0)
			length = next
		}
		return kept.count == segments.count ? path : "…/\(kept.joined(separator: "/"))"
	}
}

public protocol DriveWatchesAPI: Sendable {
	func watches() async throws -> [DriveWatch]
	func stop(folderId: String, idempotencyKey: String) async throws
}

/// Settings › Integrations › Google Drive › Folder watches. Read and stop only: adding a watch
/// stays in an agent's trigger settings, as on the web.
@MainActor
@Observable
public final class DriveWatchesStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading
		case loaded
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	public private(set) var watches: [DriveWatch] = []
	/// Watches with a stop in flight, by `DriveWatch.id`.
	public private(set) var stopping: Set<String> = []
	public private(set) var actionError: String?
	/// False only for viewers; the server decides for everyone else.
	public let canWrite: Bool
	@ObservationIgnored private let api: any DriveWatchesAPI

	public init(api: any DriveWatchesAPI, canWrite: Bool) {
		self.api = api
		self.canWrite = canWrite
	}

	public func load() async {
		if phase != .loaded { phase = .loading }
		do {
			watches = try await api.watches()
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? DriveWatchesCopy.loadError
			if phase == .loaded { actionError = message } else { phase = .failed(message) }
		}
	}

	/// Optimistic; the row comes back if the server refuses.
	public func stop(_ watch: DriveWatch) async {
		guard canWrite, !stopping.contains(watch.id), let index = watches.firstIndex(of: watch) else { return }
		watches.remove(at: index)
		stopping.insert(watch.id)
		actionError = nil
		defer { stopping.remove(watch.id) }
		do {
			try await api.stop(folderId: watch.folderId, idempotencyKey: UUID().uuidString)
		} catch {
			watches.insert(watch, at: min(index, watches.count))
			actionError = (error as? SettingsError)?.message ?? "Couldn't stop that watch."
		}
	}
}

/// Copy shared with `DRIVE_COPY` on the web (`apps/web/src/lib/drive-copy.ts`).
public enum DriveWatchesCopy {
	public static let label = "Folder watches"
	public static let emptyTitle = "No folders are being watched"
	public static let emptyDescription =
		"Watches are set up from an agent's trigger settings. Once an agent watches a folder, it shows up here."
	public static let loadError = "Could not load folder watches"
	public static let stopWatch = "Stop watch"
	public static func stopWatchLabel(_ folder: String) -> String { "Stop watch for \(folder)" }
	public static let viewerReadOnly = "Viewers can read but not change this"
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

	public func watches() async throws -> [DriveWatch] {
		let (data, status) = try await http.send("GET", "api/integrations/google-drive/watched-folders")
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: DriveWatchesCopy.loadError)
		}
		return try SettingsHTTP.decode([Wire].self, data).map {
			DriveWatch(
				folderId: $0.folderId, name: $0.name, path: $0.path,
				lastFiredAt: SettingsDates.parse($0.lastFiredAt), integrationId: $0.integrationId,
				account: $0.account, triggerNames: $0.triggers.map(\.name))
		}
	}

	public func stop(folderId: String, idempotencyKey: String) async throws {
		// The server accepts letters, digits, "_" and "-" in a folder id; encode anyway so a
		// stray character can never reshape the path.
		let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
		let encoded = folderId.addingPercentEncoding(withAllowedCharacters: allowed) ?? folderId
		let (data, status) = try await http.send(
			"DELETE", "api/integrations/google-drive/watched-folders/\(encoded)", key: idempotencyKey)
		guard status == 200 else {
			throw SettingsHTTP.error(status: status, data: data, fallback: "Couldn't stop that watch.")
		}
	}
}
