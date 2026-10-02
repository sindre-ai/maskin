import Foundation
import Observation

/// One file open in the viewer.
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

	@ObservationIgnored private let remote: any FilesRemote
	@ObservationIgnored private var generation = 0

	public init(fileId: String, remote: any FilesRemote, preload: FileDetail? = nil) {
		self.fileId = fileId
		self.remote = remote
		if let preload {
			apply(preload)
			phase = .loaded
		}
	}

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
		} catch {
			guard mine == generation else { return }
			let e = error as? FileError
			isOffline = e?.isOffline ?? false
			isNotFound = e?.isNotFound ?? false
			// A refresh that fails keeps the file already on screen.
			if file == nil { phase = .failed(e?.message ?? "Something went wrong. Try again.") }
		}
	}

	private func apply(_ loaded: FileDetail) {
		if file?.data != loaded.data || file == nil {
			contentRevision += 1
			text = Self.decodeText(loaded)
		}
		file = loaded
	}

	private static func decodeText(_ file: FileDetail) -> String? {
		switch file.kind {
		case .markdown, .text, .source: file.text
		default: nil
		}
	}

	/// Removes every file written for sharing (sign-out, viewer closed).
	public nonisolated static func clearExports() { FileExporter.clearAll() }

	/// "2.4 MB" style size.
	public static func sizeText(_ bytes: Int) -> String {
		ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
	}
}
