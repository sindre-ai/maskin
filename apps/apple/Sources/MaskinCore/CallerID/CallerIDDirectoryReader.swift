import Foundation

/// How the call directory extension reads the file the app wrote (`FileCallerIDListStore`).
///
/// Foundation only, on purpose: the extension compiles this file directly instead of linking
/// MaskinCore, because an extension's memory budget is small. A test writes a file with the app's
/// store and reads it back here, so the two cannot drift apart.
public enum CallerIDDirectoryReader {
	public struct Entry: Equatable, Sendable {
		public var number: Int64
		public var label: String
		public init(number: Int64, label: String) {
			self.number = number
			self.label = label
		}
	}

	public struct UnsupportedVersion: Error, Equatable {
		public var version: Int
	}

	/// The App Group both the app and the extension are signed with.
	public static let appGroupIdentifier = "group.io.maskin.app"
	/// Where the file sits inside the App Group folder.
	public static let relativePath = "CallerID/caller-id.json"
	/// The file layout this reader understands (`CallerIDFile.currentVersion` in the app).
	public static let supportedVersion = 1

	/// The file in the App Group container, or nil when this process isn't signed with the group.
	public static func fileURL(fileManager: FileManager = .default) -> URL? {
		fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
			.appendingPathComponent(relativePath)
	}

	/// The numbers and names in the file, as written. Throws when the file is unreadable or has a
	/// layout this build does not know.
	public static func read(from url: URL) throws -> [Entry] {
		let file = try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
		guard file.version == supportedVersion else { throw UnsupportedVersion(version: file.version) }
		return file.entries.map { Entry(number: $0.number, label: $0.label) }
	}

	/// What the phone will accept: ascending by number, each number once, none zero or negative.
	/// The app writes them this way already; this keeps one odd file from failing the whole load.
	public static func registrable(_ entries: [Entry]) -> [Entry] {
		var result: [Entry] = []
		for entry in entries.sorted(by: { $0.number < $1.number }) where entry.number > 0 {
			if result.last?.number != entry.number { result.append(entry) }
		}
		return result
	}

	private struct File: Decodable {
		var version: Int
		var entries: [Row]
	}

	private struct Row: Decodable {
		var number: Int64
		var label: String
	}
}
