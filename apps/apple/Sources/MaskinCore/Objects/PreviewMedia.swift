import Foundation

/// One file that goes out with a draft, ready to draw: a picture, a video, or anything else
/// (a document, which gets the plain file row).
public struct PreviewMediaItem: Sendable, Equatable, Identifiable {
	public enum Kind: Sendable, Equatable {
		case image, video, other
	}

	public var file: FileReference
	public var kind: Kind
	public var id: String { file.id }

	public init(file: FileReference) {
		self.file = file
		let mime = file.mimeType.lowercased()
		switch FileContentKind.classify(mimeType: file.mimeType, name: file.name) {
		case .image: kind = .image
		default: kind = mime.hasPrefix("video/") ? .video : .other
		}
	}
}

/// What a draft's `media_file_ids` become on screen: the files in the order the draft lists them,
/// with the wording the web card uses. Pure, so the order and the skipping are tested here.
public enum PreviewMedia {
	/// The files for `ids`, in the order of `ids`. An id nobody can read (deleted, another
	/// workspace) is left out without a trace, a repeated id is drawn once, and ids are matched
	/// ignoring case. Never an id as text.
	public static func items(ids: [String], summaries: [FileSummary]) -> [PreviewMediaItem] {
		var byID: [String: FileSummary] = [:]
		for summary in summaries { byID[summary.id.lowercased()] = summary }
		var seen = Set<String>()
		var items: [PreviewMediaItem] = []
		for id in ids {
			let key = id.lowercased()
			guard seen.insert(key).inserted, let found = byID[key] else { continue }
			items.append(
				PreviewMediaItem(
					file: FileReference(
						id: found.id, name: found.name, mimeType: found.mimeType, sizeBytes: found.sizeBytes)))
		}
		return items
	}

	/// "3 / 7": where the person is in the strip. Same text as the web card. Empty for one item.
	public static func counterText(index: Int, count: Int) -> String {
		count > 1 ? "\(index + 1) / \(count)" : ""
	}

	/// "Image 3 of 7", "Video 1 of 2", "File 2 of 2"; just "Image" when it is the only one.
	public static func accessibilityLabel(for item: PreviewMediaItem, index: Int, count: Int) -> String {
		let noun: String
		switch item.kind {
		case .image: noun = "Image"
		case .video: noun = "Video"
		case .other: noun = "File"
		}
		return count > 1 ? "\(noun) \(index + 1) of \(count)" : noun
	}

	/// A video above this size is a file row (open it to watch), not read into memory to play here.
	public static let maxPlayableVideoBytes = 100 * 1024 * 1024
}
