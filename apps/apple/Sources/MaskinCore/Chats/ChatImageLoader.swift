import Foundation

/// Decoded thumbnails kept in memory, readable from any thread without waiting: a view that
/// scrolls back over a photo draws it straight away instead of flashing a placeholder.
final class ThumbnailMemory: @unchecked Sendable {
	private let lock = NSLock()
	private let capacity: Int
	private var images: [String: DecodedImage] = [:]
	private var order: [String] = []

	init(capacity: Int) { self.capacity = capacity }

	func get(_ id: String) -> DecodedImage? { lock.withLock { images[id] } }

	func set(_ image: DecodedImage, for id: String) {
		lock.withLock {
			images[id] = image
			order.removeAll { $0 == id }
			order.append(id)
			while order.count > capacity { images[order.removeFirst()] = nil }
		}
	}
}

/// Fetches the pictures attached to chat messages and hands back bounded thumbnails.
///
/// A file arrives whole (up to 10 MB, base64 in JSON), so each is fetched once and the decoded
/// thumbnail is kept: scrolling a thread back over a photo must not download it again. Rows that
/// ask for the same file while it is loading share one request. A failure is not remembered, so
/// the next time the photo scrolls into view it is tried again.
public actor ChatImageLoader {
	/// Longest side of the kept thumbnail, in pixels: sharp at message size on a 3x screen.
	public static let thumbnailPixels = 900

	private let fetch: @Sendable (String) async throws -> Data
	private let memory: ThumbnailMemory
	private var inFlight: [String: Task<DecodedImage?, Never>] = [:]

	public init(capacity: Int = 60, fetch: @escaping @Sendable (String) async throws -> Data) {
		self.fetch = fetch
		self.memory = ThumbnailMemory(capacity: capacity)
	}

	public init(files: any FilesRemote, capacity: Int = 60) {
		self.init(capacity: capacity) { id in try await files.file(id: id).data }
	}

	/// The thumbnail if it has already been loaded; never waits and never starts a fetch.
	public nonisolated func cachedImage(for fileID: String) -> DecodedImage? { memory.get(fileID) }

	public func image(for fileID: String) async -> DecodedImage? {
		if let hit = memory.get(fileID) { return hit }
		if let running = inFlight[fileID] { return await running.value }
		let fetch = fetch
		let task = Task<DecodedImage?, Never> {
			guard let data = try? await fetch(fileID) else { return nil }
			// Decode off the actor's executor: ImageIO work on a large photo is not instant.
			return await Task.detached(priority: .userInitiated) {
				FileImageDecoder.thumbnail(data, maxPixel: Self.thumbnailPixels)
			}.value
		}
		inFlight[fileID] = task
		let result = await task.value
		inFlight[fileID] = nil
		if let result { memory.set(result, for: fileID) }
		return result
	}
}
