import Foundation

/// The last snapshot the widget drew, so it never goes blank offline. Lives in the widget
/// extension's OWN container: the app never reads or writes it, so no App Group is needed.
public protocol WidgetSnapshotCache: Sendable {
	func load() -> WidgetSnapshot?
	func save(_ snapshot: WidgetSnapshot)
	func clear()
}

public final class InMemoryWidgetSnapshotCache: WidgetSnapshotCache, @unchecked Sendable {
	private let lock = NSLock()
	private var snapshot: WidgetSnapshot?
	public init(_ snapshot: WidgetSnapshot? = nil) { self.snapshot = snapshot }
	public func load() -> WidgetSnapshot? { lock.withLock { snapshot } }
	public func save(_ snapshot: WidgetSnapshot) { lock.withLock { self.snapshot = snapshot } }
	public func clear() { lock.withLock { snapshot = nil } }
}

/// One small JSON file, written atomically. A corrupt or unreadable file is a cache miss, never
/// an error: the widget just fetches.
public struct FileWidgetSnapshotCache: WidgetSnapshotCache {
	public let fileURL: URL

	public init(fileURL: URL = Self.defaultFileURL()) { self.fileURL = fileURL }

	public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
		let base =
			fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("widget-snapshot.json")
	}

	public func load() -> WidgetSnapshot? {
		guard let data = try? Data(contentsOf: fileURL) else { return nil }
		return try? Self.decoder.decode(WidgetSnapshot.self, from: data)
	}

	public func save(_ snapshot: WidgetSnapshot) {
		guard let data = try? Self.encoder.encode(snapshot) else { return }
		try? FileManager.default.createDirectory(
			at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
		var options: Data.WritingOptions = [.atomic]
		#if os(iOS)
			// Readable once the phone has been unlocked after boot, so a locked-screen refresh works.
			options.insert(.completeFileProtectionUntilFirstUserAuthentication)
		#endif
		try? data.write(to: fileURL, options: options)
	}

	public func clear() { try? FileManager.default.removeItem(at: fileURL) }

	private static let encoder: JSONEncoder = {
		let e = JSONEncoder()
		e.dateEncodingStrategy = .secondsSince1970
		return e
	}()
	private static let decoder: JSONDecoder = {
		let d = JSONDecoder()
		d.dateDecodingStrategy = .secondsSince1970
		return d
	}()
}
