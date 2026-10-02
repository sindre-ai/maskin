import Foundation

/// How the viewer shows a file, decided from its MIME type (and name as a fallback). Mirrors the
/// web's `file-body.tsx` routing.
public enum FileContentKind: Sendable, Equatable {
	case markdown
	/// Plain text, JSON, YAML, XML and the like; shown monospaced.
	case text
	/// HTML / SVG / scripts: never executed or rendered natively, shown as source.
	case source
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
		if unsafeInline.contains(mime) { return .source }
		if mime == "application/pdf" { return .pdf }
		if mime.hasPrefix("image/") { return .image }
		if mime.hasPrefix("text/") || textExact.contains(mime) { return .text }
		// Generic types fall back to the extension (uploads often arrive as octet-stream).
		if mime == "application/octet-stream" || mime.isEmpty {
			switch (name as NSString).pathExtension.lowercased() {
			case "md", "markdown": return .markdown
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
		case .image: "Image"
		case .pdf: "PDF"
		case .other: "File"
		}
	}
}

/// A pinned review comment on a file. Read-only on iOS.
public struct FileAnnotation: Identifiable, Sendable, Equatable {
	public var id: String
	public var pinNumber: Int?
	public var comment: String

	public init(id: String, pinNumber: Int? = nil, comment: String) {
		self.id = id
		self.pinNumber = pinNumber
		self.comment = comment
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

public protocol FilesRemote: Sendable {
	/// `GET /api/files/{id}`: metadata and bytes (inline, utf8 or base64) in one response.
	func file(id: String) async throws -> FileDetail
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
