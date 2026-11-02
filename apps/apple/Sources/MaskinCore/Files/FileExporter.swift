import Foundation

/// Writes a file's bytes to a temporary location for sharing. Nothing is written until the person
/// actually shares (see `FileExport` in the Files screen), and the whole directory is removed on
/// the next export, when the viewer closes and on sign-out (`FileStore.clearExports()`).
public enum FileExporter {
	/// The largest file name any common filesystem accepts, in UTF-8 bytes.
	static let maxNameBytes = 255

	public static var defaultDirectory: URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("maskin-files", isDirectory: true)
	}

	/// A name that is safe to create: no separators, control characters or dot-only names, at most
	/// 255 UTF-8 bytes, keeping the extension so the receiving app still recognises the type.
	public static func safeName(_ name: String) -> String {
		let banned = CharacterSet(charactersIn: "/\\:").union(.controlCharacters).union(.newlines)
		// Measured in decomposed form: that is what Foundation hands the filesystem.
		var cleaned = name.decomposedStringWithCanonicalMapping.unicodeScalars.map { banned.contains($0) ? "-" : String($0) }.joined()
		cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
		if cleaned.isEmpty || cleaned.allSatisfy({ $0 == "." }) { return "file" }
		guard cleaned.utf8.count > maxNameBytes else { return cleaned }

		let ext = (cleaned as NSString).pathExtension
		let suffix = ext.isEmpty || ext.utf8.count > 16 ? "" : ".\(ext)"
		let base = suffix.isEmpty ? cleaned : String(cleaned.dropLast(suffix.count))
		var trimmed = ""
		var used = suffix.utf8.count
		for character in base {
			let size = String(character).utf8.count
			if used + size > maxNameBytes { break }
			trimmed.append(character)
			used += size
		}
		return trimmed.isEmpty ? "file" : trimmed + suffix
	}

	/// Replaces any earlier export and writes `file` to a fresh directory. Throws on I/O failure.
	@discardableResult
	public static func write(_ file: FileDetail, in root: URL = defaultDirectory) throws -> URL {
		let manager = FileManager.default
		try? manager.removeItem(at: root)
		let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
		try manager.createDirectory(at: dir, withIntermediateDirectories: true)
		let url = dir.appendingPathComponent(safeName(file.name))
		#if os(iOS) || os(watchOS) || os(tvOS)
			try file.data.write(to: url, options: [.atomic, .completeFileProtection])
		#else
			try file.data.write(to: url, options: .atomic)
		#endif
		return url
	}

	public static func clearAll(in root: URL = defaultDirectory) {
		try? FileManager.default.removeItem(at: root)
	}
}
