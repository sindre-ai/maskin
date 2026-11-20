import Foundation

/// Puts a received chat file on disk under its own name, so Quick Look, Save to Files and Save to
/// Photos have a real file to work with. Unlike `FileExporter` it keeps every file it wrote (a
/// message's files are previewed side by side), and the whole directory goes on sign-out.
public struct AttachmentDownloader: Sendable {
	private let remote: any FilesRemote
	private let root: URL
	/// Fetches a download link (for a file over the inline cap) to a temporary file.
	private let fetch: @Sendable (URL) async throws -> URL

	public init(
		remote: any FilesRemote, root: URL = AttachmentDownloader.defaultRoot,
		fetch: @escaping @Sendable (URL) async throws -> URL = AttachmentDownloader.downloadToTemporaryFile
	) {
		self.remote = remote
		self.root = root
		self.fetch = fetch
	}

	public static var defaultRoot: URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("maskin-attachments", isDirectory: true)
	}

	/// Where file `id` named `name` lives once written. One folder per file id keeps two files with
	/// the same name apart.
	public func location(forFile id: String, name: String) -> URL {
		root.appendingPathComponent(Self.folderName(id), isDirectory: true)
			.appendingPathComponent(FileExporter.safeName(name))
	}

	/// The local copy of file `id`, fetching it the first time. Throws a `FileError` the person can read.
	public func localURL(forFile id: String) async throws -> URL {
		let detail = try await remote.file(id: id)
		let url = location(forFile: id, name: detail.name)
		let manager = FileManager.default
		if let size = (try? manager.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 0, size == detail.sizeBytes {
			return url
		}
		try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		if detail.contentOmitted {
			guard let link = detail.downloadURL else {
				throw FileError("\(detail.name) is too big to open here.")
			}
			let temporary: URL
			do { temporary = try await fetch(link) } catch {
				throw FileError("Couldn't download \(detail.name).", isOffline: (error as? URLError)?.code == .notConnectedToInternet)
			}
			try? manager.removeItem(at: url)
			try manager.moveItem(at: temporary, to: url)
		} else {
			#if os(iOS) || os(watchOS) || os(tvOS)
				try detail.data.write(to: url, options: [.atomic, .completeFileProtection])
			#else
				try detail.data.write(to: url, options: .atomic)
			#endif
		}
		return url
	}

	public static func clearAll(in root: URL = defaultRoot) {
		try? FileManager.default.removeItem(at: root)
	}

	/// Ids come from the server; keep only what is safe in a folder name.
	static func folderName(_ id: String) -> String {
		let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
		return safe.isEmpty ? "file" : safe
	}

	@Sendable
	public static func downloadToTemporaryFile(_ url: URL) async throws -> URL {
		let (temporary, response) = try await URLSession.shared.download(from: url)
		if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
			try? FileManager.default.removeItem(at: temporary)
			throw URLError(.badServerResponse)
		}
		return temporary
	}
}

/// What can be done with a received file besides opening it. Pure, so the menus can be tested.
public enum AttachmentSaveRules {
	/// Pictures and videos can go to the photo library; everything else only to Files.
	public static func canSaveToPhotos(mimeType: String?, name: String?) -> Bool {
		kind(mimeType: mimeType, name: name) != nil
	}

	public enum MediaKind: Equatable, Sendable { case photo, video }

	/// The library kind of a file, from its type, falling back to the extension when the type is generic.
	public static func kind(mimeType: String?, name: String?) -> MediaKind? {
		let mime = (mimeType ?? "").lowercased()
		if mime.hasPrefix("image/") { return .photo }
		if mime.hasPrefix("video/") { return .video }
		let ext = ((name ?? "") as NSString).pathExtension.lowercased()
		if ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tif", "tiff"].contains(ext) { return .photo }
		if ["mov", "mp4", "m4v"].contains(ext) { return .video }
		return nil
	}
}
