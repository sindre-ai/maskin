import Foundation

/// Where the list the phone loads is kept. The call directory extension (a separate process that
/// runs with the phone locked and has no network) reads the same file.
public protocol CallerIDListStoring: Sendable {
	func save(_ entries: [CallerIDEntry]) throws
	func load() -> [CallerIDEntry]?
	func clear()
}

/// What the file holds. `version` lets a reader refuse a layout it does not know.
struct CallerIDFile: Codable, Equatable {
	static let currentVersion = 1
	var version: Int
	var entries: [CallerIDEntry]
}

/// One JSON file in the App Group folder. People's numbers and names sit in it, so it is readable
/// only after the first unlock (the extension runs with the phone locked), kept out of backups and
/// iCloud, and nothing in here ever logs a number or a name.
public struct FileCallerIDListStore: CallerIDListStoring {
	public let fileURL: URL

	public init(fileURL: URL) { self.fileURL = fileURL }

	/// The store in the App Group container, or nil when this build isn't signed with the group.
	public static func shared(fileManager: FileManager = .default) -> FileCallerIDListStore? {
		fileManager.containerURL(forSecurityApplicationGroupIdentifier: ShareQueue.appGroupIdentifier)
			.map {
				FileCallerIDListStore(
					fileURL: $0.appendingPathComponent("CallerID", isDirectory: true)
						.appendingPathComponent("caller-id.json"))
			}
	}

	public func save(_ entries: [CallerIDEntry]) throws {
		let data = try JSONEncoder().encode(CallerIDFile(version: CallerIDFile.currentVersion, entries: entries))
		let directory = fileURL.deletingLastPathComponent()
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		var options: Data.WritingOptions = [.atomic]
		#if os(iOS)
			// Readable once the phone has been unlocked after boot: the extension runs while it is locked.
			options.insert(.completeFileProtectionUntilFirstUserAuthentication)
		#endif
		try data.write(to: fileURL, options: options)
		// An atomic write makes a new file each time, so the mark goes on after every save.
		Self.excludeFromBackup(directory)
		Self.excludeFromBackup(fileURL)
	}

	public func load() -> [CallerIDEntry]? {
		guard let data = try? Data(contentsOf: fileURL),
			let file = try? JSONDecoder().decode(CallerIDFile.self, from: data),
			file.version == CallerIDFile.currentVersion
		else { return nil }
		return file.entries
	}

	public func clear() { try? FileManager.default.removeItem(at: fileURL) }

	private static func excludeFromBackup(_ url: URL) {
		var url = url
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		try? url.setResourceValues(values)
	}
}

public final class InMemoryCallerIDListStore: CallerIDListStoring, @unchecked Sendable {
	private let lock = NSLock()
	private var entries: [CallerIDEntry]?
	public init(_ entries: [CallerIDEntry]? = nil) { self.entries = entries }
	public func save(_ entries: [CallerIDEntry]) throws { lock.withLock { self.entries = entries } }
	public func load() -> [CallerIDEntry]? { lock.withLock { entries } }
	public func clear() { lock.withLock { entries = nil } }
}
