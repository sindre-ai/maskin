import Foundation
import Observation

/// One file open in the viewer, including its review pins.
///
/// Pins are saved as one whole list (the server replaces it), so edits are optimistic, saved one
/// request at a time, and rolled back to the last list the server confirmed if a save fails.
@MainActor
@Observable
public final class FileStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public let fileId: String
	public private(set) var file: FileDetail?
	/// The file's UTF-8 text, decoded once per load rather than on every access.
	public private(set) var text: String?
	/// Bumps whenever the bytes on screen change, so views re-decode only then.
	public private(set) var contentRevision = 0
	public private(set) var phase: Phase = .idle
	public private(set) var isOffline = false
	public private(set) var isNotFound = false

	/// A pin that has been placed but not yet given a comment. It lives outside `file` so cancelling
	/// never touches (or saves) the real list.
	public private(set) var draft: FileAnnotation?
	/// The last failed pin save, cleared by the next successful one.
	public private(set) var saveError: String?
	public private(set) var isSaving = false

	/// The file's tags, A to Z. Read separately from the bytes, so they arrive just after the file.
	public private(set) var tags: [String] = []
	/// Every tag in use in the workspace with its count, A to Z, for picking an existing one.
	public private(set) var tagCounts: [FileTagCount] = []
	/// The last failed tag save, cleared by the next successful one.
	public private(set) var tagError: String?

	@ObservationIgnored private let remote: any FilesRemote
	@ObservationIgnored private var generation = 0
	/// The pin list the server last acknowledged; what a failed save rolls back to.
	@ObservationIgnored private var confirmed: [FileAnnotation] = []
	@ObservationIgnored private var needsSave = false
	/// The tag list the server last acknowledged; what a failed tag save rolls back to.
	@ObservationIgnored private var confirmedTags: [String] = []
	@ObservationIgnored private var needsTagSave = false
	@ObservationIgnored private var isSavingTags = false

	public init(fileId: String, remote: any FilesRemote, preload: FileDetail? = nil) {
		self.fileId = fileId
		self.remote = remote
		if let preload {
			apply(preload)
			phase = .loaded
		}
	}

	public var annotations: [FileAnnotation] { file?.annotations ?? [] }

	/// Pins are placed on rendered HTML, like the web's annotate mode.
	public var canPlacePins: Bool { file?.kind == .html }

	public func load() async {
		generation += 1
		let mine = generation
		if file == nil { phase = .loading }
		do {
			let loaded = try await remote.file(id: fileId)
			guard mine == generation else { return }
			apply(loaded)
			isOffline = false
			isNotFound = false
			phase = .loaded
			await loadTags(generation: mine)
		} catch {
			guard mine == generation else { return }
			let e = error as? FileError
			isOffline = e?.isOffline ?? false
			isNotFound = e?.isNotFound ?? false
			// A refresh that fails keeps the file already on screen.
			if file == nil { phase = .failed(e?.message ?? "Something went wrong. Try again.") }
		}
	}

	private func apply(_ incoming: FileDetail) {
		var loaded = incoming
		if file?.data != loaded.data || file == nil {
			contentRevision += 1
			text = Self.decodeText(loaded)
		}
		if isSaving, let current = file {
			// Local edits are mid-flight; don't let a refresh flash the older list over them.
			loaded.annotations = current.annotations
		} else {
			loaded.annotations = FileAnnotationRules.hydrated(loaded.annotations)
			confirmed = loaded.annotations
		}
		file = loaded
	}

	private static func decodeText(_ file: FileDetail) -> String? {
		switch file.kind {
		case .markdown, .text, .source, .html: file.text
		default: nil
		}
	}

	// MARK: Tags

	/// Whether another tag fits on this file.
	public var canAddTag: Bool { tags.count < FileTagRules.maxPerFile }

	/// The workspace's tags not already on this file, for the picker.
	public var suggestedTags: [FileTagCount] { tagCounts.filter { !tags.contains($0.tag) } }

	private func loadTags(generation mine: Int) async {
		if let loaded = try? await remote.tags(ofFile: fileId), mine == generation, !isSavingTags {
			tags = FileTagRules.sorted(loaded)
			confirmedTags = tags
		}
	}

	/// The tags in use across the workspace. A failure keeps what was last loaded.
	public func loadTagCounts() async {
		guard let counts = try? await remote.tagCounts() else { return }
		tagCounts = FileTagRules.sorted(counts)
	}

	/// Adds a tag, spelled the way the server stores it. Anything the server would refuse, or a tag
	/// the file already has, is ignored.
	public func addTag(_ raw: String) async {
		guard let tag = FileTagRules.normalized(raw), !tags.contains(tag), canAddTag else { return }
		tags = FileTagRules.sorted(tags + [tag])
		await persistTags()
	}

	public func removeTag(_ tag: String) async {
		guard tags.contains(tag) else { return }
		tags.removeAll { $0 == tag }
		await persistTags()
	}

	public func clearTagError() { tagError = nil }

	/// Sends the current tag list, optimistically. Overlapping calls coalesce like pin saves: while
	/// one request is in flight, later edits just mark the list dirty and the newest state goes next.
	private func persistTags() async {
		needsTagSave = true
		guard !isSavingTags else { return }
		isSavingTags = true
		defer { isSavingTags = false }
		while needsTagSave {
			needsTagSave = false
			let sending = tags
			do {
				let saved = try await remote.saveTags(
					fileId: fileId, tags: sending, idempotencyKey: UUID().uuidString)
				confirmedTags = FileTagRules.sorted(saved)
				tagError = nil
				if !needsTagSave { tags = confirmedTags }
			} catch {
				needsTagSave = false
				tags = confirmedTags
				tagError = (error as? FileError)?.message ?? "Couldn't save the tags. Try again."
			}
		}
		// A new tag may now be in use; refresh the picker's counts.
		await loadTagCounts()
	}

	// MARK: Pins

	/// Starts a pin at `point`. Returns false (and places nothing) when the file is not pinnable or
	/// already holds the server's maximum.
	@discardableResult
	public func beginPin(at point: FilePoint, selector: String = "", bounds: FileBounds = .zero) -> Bool {
		guard canPlacePins, annotations.count < FileAnnotationRules.maxCount else { return false }
		draft = FileAnnotation(
			id: UUID().uuidString, pinNumber: FileAnnotationRules.nextPinNumber(in: annotations),
			comment: "", selector: String(selector.prefix(1000)), bounds: bounds, position: point.clamped)
		return true
	}

	/// Fills in the element under a freshly placed pin once the page has answered which one it is.
	public func resolveDraftTarget(selector: String, bounds: FileBounds) {
		guard draft != nil else { return }
		draft?.selector = String(selector.prefix(1000))
		draft?.bounds = bounds
	}

	public func cancelDraft() { draft = nil }

	/// Saves the draft as a real pin. A blank comment is ignored: a pin that says nothing is noise.
	public func commitDraft(comment: String) async {
		guard var pin = draft, var current = file else { return }
		let text = FileAnnotationRules.sanitized(comment)
		guard !text.isEmpty else { return }
		pin.comment = text
		draft = nil
		current.annotations.append(pin)
		file = current
		await persist()
	}

	public func updateComment(id: String, comment: String) async {
		let text = FileAnnotationRules.sanitized(comment)
		guard !text.isEmpty, var current = file,
			let index = current.annotations.firstIndex(where: { $0.id == id }),
			current.annotations[index].comment != text
		else { return }
		current.annotations[index].comment = text
		file = current
		await persist()
	}

	public func remove(id: String) async {
		guard var current = file, current.annotations.contains(where: { $0.id == id }) else { return }
		current.annotations.removeAll { $0.id == id }
		file = current
		await persist()
	}

	public func clearSaveError() { saveError = nil }

	/// Sends the current list. Overlapping calls coalesce: while one request is in flight, later
	/// edits just mark the list dirty and the running loop sends the newest state next.
	private func persist() async {
		needsSave = true
		guard !isSaving else { return }
		isSaving = true
		defer { isSaving = false }
		while needsSave {
			needsSave = false
			guard let sending = file?.annotations else { return }
			do {
				let saved = try await remote.saveAnnotations(
					fileId: fileId, annotations: sending, idempotencyKey: UUID().uuidString)
				confirmed = sending
				saveError = nil
				if !needsSave, file != nil { file?.annotations = FileAnnotationRules.hydrated(saved) }
			} catch {
				needsSave = false
				file?.annotations = confirmed
				saveError = (error as? FileError)?.message ?? "Couldn't save your comment. Try again."
			}
		}
	}

	/// Removes every file written for sharing (sign-out, viewer closed).
	public nonisolated static func clearExports() { FileExporter.clearAll() }

	/// "2.4 MB" style size.
	public static func sizeText(_ bytes: Int) -> String {
		ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
	}
}
