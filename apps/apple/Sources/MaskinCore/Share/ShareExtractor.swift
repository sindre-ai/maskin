import Foundation
import UniformTypeIdentifiers

/// What the host app said about the share besides the items themselves (`NSExtensionItem`'s
/// title / content text): Safari puts the page title there.
public struct ShareContext: Sendable, Equatable {
	public var title: String?
	public init(title: String? = nil) { self.title = title }
}

/// Turns the extension's items into one `ShareContent`. UI-free; reads one item at a time and
/// parks files on disk, so memory stays flat however much is shared.
public struct ShareExtractor: Sendable {
	/// Every staging directory starts with this; `sweepStaleDirectories` and `cleanUp` rely on it.
	public static let workDirectoryPrefix = "maskin-share-"

	private let workDirectory: URL
	private let maxAttachments: Int
	private let maxFileBytes: Int

	public init(
		workDirectory: URL = FileManager.default.temporaryDirectory
			.appendingPathComponent("\(ShareExtractor.workDirectoryPrefix)\(UUID().uuidString)", isDirectory: true),
		maxAttachments: Int = ShareLimits.maxAttachments, maxFileBytes: Int = ShareLimits.maxFileBytes
	) {
		self.workDirectory = workDirectory
		self.maxAttachments = maxAttachments
		self.maxFileBytes = maxFileBytes
	}

	/// Removes `maskin-share-*` directories older than `age` seconds: leftovers of an extension
	/// the system killed before it could clean up. The age keeps a concurrently running share safe.
	public static func sweepStaleDirectories(
		in root: URL = FileManager.default.temporaryDirectory, olderThan age: TimeInterval = 3600,
		now: Date = Date()
	) {
		let keys: [URLResourceKey] = [.contentModificationDateKey]
		guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: keys)
		else { return }
		for entry in entries where entry.lastPathComponent.hasPrefix(workDirectoryPrefix) {
			let modified = (try? entry.resourceValues(forKeys: Set(keys)))?.contentModificationDate ?? .distantPast
			if now.timeIntervalSince(modified) > age { try? FileManager.default.removeItem(at: entry) }
		}
	}

	public func extract(from sources: [any ShareItemSource], context: ShareContext = .init()) async -> ShareContent {
		var content = ShareContent()
		var texts: [String] = []
		for source in sources {
			if source.conforms(to: .image) {
				await addAttachment(from: source, kind: .image, to: &content)
				// An image shared from the web can carry its page's address too; keep it as the link.
				if content.link == nil, source.conforms(to: .url), let url = try? await source.loadURL(),
					Self.isWebURL(url)
				{
					content.link = url
				}
			} else if source.conforms(to: .pdf) {
				await addAttachment(from: source, kind: .pdf, to: &content)
			} else if source.conforms(to: .url) {
				await addURL(from: source, to: &content, texts: &texts)
			} else if source.conforms(to: .plainText) || source.conforms(to: .text) {
				if let text = try? await source.loadText() { addText(text, to: &content, texts: &texts) }
			} else if source.conforms(to: .data) {
				await addAttachment(from: source, kind: .file, to: &content)
			} else {
				content.skipped.append(ShareSkip(name: source.suggestedName ?? "An item", reason: .unsupported))
			}
		}
		if content.text == nil, !texts.isEmpty { content.text = texts.joined(separator: "\n\n") }
		if content.link != nil, let title = context.title?.trimmingCharacters(in: .whitespacesAndNewlines),
			!title.isEmpty, title != content.link?.absoluteString
		{
			content.linkTitle = title
		}
		// Selected text next to a link IS the quote; a title equal to the text adds nothing.
		if let text = content.text, text == content.linkTitle { content.text = nil }
		return content
	}

	private func addURL(from source: any ShareItemSource, to content: inout ShareContent, texts: inout [String]) async {
		guard let url = try? await source.loadURL() else {
			content.skipped.append(ShareSkip(name: source.suggestedName ?? "A link", reason: .unreadable))
			return
		}
		if url.isFileURL {
			// A file shared as a URL (Files, Finder-style): take the file behind it.
			await addAttachment(from: source, kind: nil, to: &content)
		} else if Self.isWebURL(url) {
			if content.link == nil { content.link = url } else { addText(url.absoluteString, to: &content, texts: &texts) }
		} else {
			addText(url.absoluteString, to: &content, texts: &texts)
		}
	}

	/// A shared string that is just one web address is a link; anything else is text.
	private func addText(_ raw: String, to content: inout ShareContent, texts: inout [String]) {
		let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		if content.link == nil, !text.contains(where: \.isWhitespace), let url = URL(string: text), Self.isWebURL(url) {
			content.link = url
			return
		}
		if text.count > ShareLimits.maxTextCharacters,
			!content.skipped.contains(where: { $0.reason == .truncatedText })
		{
			content.skipped.append(ShareSkip(name: "Text", reason: .truncatedText))
		}
		texts.append(String(text.prefix(ShareLimits.maxTextCharacters)))
	}

	static func isWebURL(_ url: URL) -> Bool {
		guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
		return url.host?.isEmpty == false
	}

	/// - Parameter kind: `nil` lets the file's own type decide (a file URL).
	private func addAttachment(
		from source: any ShareItemSource, kind: ShareAttachment.Kind?, to content: inout ShareContent
	) async {
		let label = source.suggestedName ?? "An item"
		guard content.attachments.count < maxAttachments else {
			if !content.skipped.contains(where: { $0.reason == .overLimit }) {
				content.skipped.append(ShareSkip(name: label, reason: .overLimit))
			}
			return
		}
		do {
			try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
			let dir = workDirectory
			let limit = maxFileBytes
			let suggested = source.suggestedName
			let wanted: UTType = kind == .image ? .image : (kind == .pdf ? .pdf : .data)
			let attachment: ShareAttachment = try await source.withFile(conformingTo: wanted) { url in
				try Self.stage(file: url, kind: kind, suggestedName: suggested, in: dir, limit: limit)
			}
			content.attachments.append(attachment)
		} catch let skip as StageFailure {
			content.skipped.append(ShareSkip(name: skip.name, reason: skip.reason))
		} catch {
			content.skipped.append(ShareSkip(name: label, reason: .unreadable))
		}
	}

	private struct StageFailure: Error {
		var name: String
		var reason: ShareSkip.Reason
	}

	private static func stage(
		file url: URL, kind: ShareAttachment.Kind?, suggestedName: String?, in dir: URL, limit: Int
	) throws -> ShareAttachment {
		let type = UTType(filenameExtension: url.pathExtension)
		let resolved: ShareAttachment.Kind =
			kind ?? (type?.conforms(to: .image) == true ? .image : (type?.conforms(to: .pdf) == true ? .pdf : .file))
		let base = displayName(suggestedName, fallback: url.lastPathComponent)
		let id = UUID()
		let target = { (ext: String) in dir.appendingPathComponent("\(id.uuidString).\(ext)") }

		if resolved == .image {
			guard let written = try? ShareImageEncoder.write(from: url, to: target) else {
				throw StageFailure(name: base, reason: .unreadable)
			}
			let name = (base as NSString).deletingPathExtension + "." + written.output.fileExtension
			return ShareAttachment(
				id: id, kind: .image, name: name, mimeType: written.output.mimeType, fileURL: written.url,
				sizeBytes: written.bytes)
		}

		let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		guard size > 0 else { throw StageFailure(name: base, reason: .unreadable) }
		guard size <= limit else { throw StageFailure(name: base, reason: .tooLarge) }
		let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension
		let destination = target(ext)
		try FileManager.default.copyItem(at: url, to: destination)
		let mime = type?.preferredMIMEType ?? (resolved == .pdf ? "application/pdf" : "application/octet-stream")
		let name = base.contains(".") || url.pathExtension.isEmpty ? base : "\(base).\(url.pathExtension)"
		return ShareAttachment(id: id, kind: resolved, name: name, mimeType: mime, fileURL: destination, sizeBytes: size)
	}

	/// A file name safe to send: no path parts, no control characters, at most 255 characters.
	static func displayName(_ suggested: String?, fallback: String) -> String {
		let raw = (suggested?.isEmpty == false ? suggested! : fallback)
		let last = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? raw
		let cleaned = String(last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
			.trimmingCharacters(in: .whitespaces)
		return String((cleaned.isEmpty ? "Shared file" : cleaned).prefix(255))
	}
}
