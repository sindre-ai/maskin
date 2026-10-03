import Foundation

/// How the viewer shows a file, decided from its MIME type (and name as a fallback). Mirrors the
/// web's `file-body.tsx` routing.
public enum FileContentKind: Sendable, Equatable {
	case markdown
	/// Plain text, JSON, YAML, XML and the like; shown monospaced.
	case text
	/// HTML / SVG / scripts: never executed or rendered natively, shown as source.
	case source
	/// HTML pages (mini-apps, prototypes): rendered in a locked-down web view so review pins can be
	/// placed on them, exactly like the web's sandboxed preview.
	case html
	case image
	case pdf
	case other

	static let unsafeInline: Set<String> = [
		"text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript",
		"text/javascript", "application/ecmascript", "text/ecmascript",
	]
	static let textExact: Set<String> = [
		"application/json", "application/yaml", "application/x-yaml", "application/xml",
	]

	public static func classify(mimeType: String, name: String = "") -> FileContentKind {
		let mime = mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
		if mime == "text/markdown" || mime == "text/x-markdown" { return .markdown }
		if mime == "text/html" || mime == "application/xhtml+xml" { return .html }
		if unsafeInline.contains(mime) { return .source }
		if mime == "application/pdf" { return .pdf }
		if mime.hasPrefix("image/") { return .image }
		if mime.hasPrefix("text/") || textExact.contains(mime) { return .text }
		// Generic types fall back to the extension (uploads often arrive as octet-stream).
		if mime == "application/octet-stream" || mime.isEmpty {
			switch (name as NSString).pathExtension.lowercased() {
			case "md", "markdown": return .markdown
			case "html", "htm": return .html
			case "txt", "json", "yaml", "yml", "csv", "log": return .text
			case "pdf": return .pdf
			case "png", "jpg", "jpeg", "gif", "webp", "heic": return .image
			default: break
			}
		}
		return .other
	}

	/// Short human label for the kind of file, for result rows and the metadata header.
	public static func label(forMime mime: String) -> String {
		switch classify(mimeType: mime) {
		case .markdown: "Markdown"
		case .text: "Text"
		case .source: "Source"
		case .html: "HTML"
		case .image: "Image"
		case .pdf: "PDF"
		case .other: "File"
		}
	}
}

/// A point on a page as fractions (0...1) of its width and height, so a pin lands in the same
/// place at any size. Matches the web overlay's `position`.
public struct FilePoint: Sendable, Equatable, Codable {
	public var x: Double
	public var y: Double

	public init(x: Double, y: Double) {
		self.x = x
		self.y = y
	}

	/// Clamped into the page so a drag past the edge still pins on it.
	public var clamped: FilePoint {
		FilePoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
	}
}

/// The element a pin points at, as fractions of the page (the web's `bounds`).
public struct FileBounds: Sendable, Equatable, Codable {
	public var x: Double
	public var y: Double
	public var w: Double
	public var h: Double

	public init(x: Double, y: Double, w: Double, h: Double) {
		self.x = x
		self.y = y
		self.w = w
		self.h = h
	}

	public static let zero = FileBounds(x: 0, y: 0, w: 0, h: 0)
}

/// A pinned review comment on a file. Carries every field the web writes (selector, bounds,
/// position): saving replaces the whole list server-side, so dropping one here would erase it for
/// everyone else.
public struct FileAnnotation: Identifiable, Sendable, Equatable {
	public var id: String
	public var pinNumber: Int?
	public var comment: String
	public var selector: String
	public var bounds: FileBounds
	/// Where the pin sits on the page. Rows written by other clients may omit it.
	public var position: FilePoint?

	public init(
		id: String, pinNumber: Int? = nil, comment: String, selector: String = "",
		bounds: FileBounds = .zero, position: FilePoint? = nil
	) {
		self.id = id
		self.pinNumber = pinNumber
		self.comment = comment
		self.selector = selector
		self.bounds = bounds
		self.position = position
	}
}

public struct FileDetail: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	public var description: String?
	public var mimeType: String
	public var sizeBytes: Int
	public var createdAt: Date?
	public var updatedAt: Date?
	public var data: Data
	public var annotations: [FileAnnotation]

	public init(
		id: String, name: String, description: String? = nil, mimeType: String, sizeBytes: Int,
		createdAt: Date? = nil, updatedAt: Date? = nil, data: Data, annotations: [FileAnnotation] = []
	) {
		self.id = id
		self.name = name
		self.description = description
		self.mimeType = mimeType
		self.sizeBytes = sizeBytes
		self.createdAt = createdAt
		self.updatedAt = updatedAt
		self.data = data
		self.annotations = annotations
	}

	public var kind: FileContentKind { .classify(mimeType: mimeType, name: name) }

	/// UTF-8 text for the text-like kinds; nil when the bytes aren't valid text.
	public var text: String? { String(data: data, encoding: .utf8) }
}

public struct FileError: Error, Equatable, Sendable {
	public var message: String
	public var isOffline: Bool
	public var isNotFound: Bool

	public init(_ message: String, isOffline: Bool = false, isNotFound: Bool = false) {
		self.message = message
		self.isOffline = isOffline
		self.isNotFound = isNotFound
	}
}

/// One row in the file browser (no bytes).
public struct FileSummary: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	public var description: String?
	public var mimeType: String
	public var sizeBytes: Int
	public var updatedAt: Date?

	public init(
		id: String, name: String, description: String? = nil, mimeType: String, sizeBytes: Int,
		updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.description = description
		self.mimeType = mimeType
		self.sizeBytes = sizeBytes
		self.updatedAt = updatedAt
	}

	public var kind: FileContentKind { .classify(mimeType: mimeType, name: name) }
}

public protocol FilesRemote: Sendable {
	/// `GET /api/files/{id}`: metadata and bytes (inline, utf8 or base64) in one response.
	func file(id: String) async throws -> FileDetail
	/// `GET /api/files`: newest first, optionally filtered by name.
	func list(query: String, limit: Int, offset: Int) async throws -> [FileSummary]
	/// `PATCH /api/files/{id}` with the complete annotation list. The server replaces the list, so
	/// callers always send everything. Returns what the server stored.
	func saveAnnotations(
		fileId: String, annotations: [FileAnnotation], idempotencyKey: String
	) async throws -> [FileAnnotation]
}

extension FilesRemote {
	public func list(query: String, limit: Int, offset: Int) async throws -> [FileSummary] {
		throw FileError("Browsing files isn't available here.")
	}

	public func saveAnnotations(
		fileId: String, annotations: [FileAnnotation], idempotencyKey: String
	) async throws -> [FileAnnotation] {
		throw FileError("Saving comments isn't available here.")
	}
}

/// How much of a text file the viewer lays out at once. A multi-megabyte file in one `Text`
/// hangs the main thread, so the viewer shows a prefix and offers "Show more".
public enum FileTextWindow {
	public static let step = 100_000
	/// Beyond this the viewer stops offering more and points at Share.
	public static let ceiling = 1_000_000

	/// The first `limit` characters (never splitting a character) and whether anything was cut.
	public static func prefix(_ text: String, limit: Int) -> (shown: Substring, isTruncated: Bool) {
		let shown = text.prefix(limit)
		return (shown, shown.endIndex != text.endIndex)
	}
}
