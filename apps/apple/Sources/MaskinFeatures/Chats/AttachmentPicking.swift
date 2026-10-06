import Foundation
import MaskinCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A photo from the picker, copied to a temp file (never loaded whole into memory).
struct PickedImageFile: Transferable {
	let url: URL

	static var transferRepresentation: some TransferRepresentation {
		FileRepresentation(importedContentType: .image) { received in
			let name = "\(UUID().uuidString)-\(received.file.lastPathComponent)"
			let destination = FileManager.default.temporaryDirectory.appendingPathComponent(name)
			try FileManager.default.copyItem(at: received.file, to: destination)
			return PickedImageFile(url: destination)
		}
	}
}

/// PhotosPickerItem is not declared Sendable; it is only ever used from the one loading task.
private struct ItemBox: @unchecked Sendable { let item: PhotosPickerItem }

enum AttachmentLoading {
	/// A photo: copy to a temp file, downsample with ImageIO, upload as JPEG (or the original when
	/// it is already small).
	static func photo(_ item: PhotosPickerItem, name: String) -> @Sendable () async throws -> PreparedChatFile {
		let box = ItemBox(item: item)
		return {
			guard let picked = try await box.item.loadTransferable(type: PickedImageFile.self) else {
				throw ChatAttachmentError("Couldn't read that photo.")
			}
			defer { try? FileManager.default.removeItem(at: picked.url) }
			guard let result = ImageDownsampler.prepare(fileAt: picked.url) else {
				throw ChatAttachmentError("That photo can't be attached.")
			}
			let base = (name as NSString).deletingPathExtension
			return PreparedChatFile(
				name: "\(base).\(result.fileExtension)", mimeType: result.mimeType, data: result.data)
		}
	}

	/// A file from the Files picker. Size is checked before a single byte is read.
	static func file(at url: URL) -> @Sendable () async throws -> PreparedChatFile {
		{
			let scoped = url.startAccessingSecurityScopedResource()
			defer { if scoped { url.stopAccessingSecurityScopedResource() } }
			let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
			guard size <= ChatLimits.maxFileBytes else {
				throw ChatAttachmentError("Over the 10 MB limit.")
			}
			let data = try Data(contentsOf: url, options: .mappedIfSafe)
			return PreparedChatFile(
				name: url.lastPathComponent, mimeType: mimeType(for: url), data: data)
		}
	}

	static func mimeType(for url: URL) -> String {
		UTType(filenameExtension: url.pathExtension)?.preferredMIMEType?.lowercased()
			?? "application/octet-stream"
	}

	static func photoName(index: Int, now: Date = Date()) -> String {
		let stamp = now.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute())
			.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
		return index == 0 ? "Photo \(stamp).jpg" : "Photo \(stamp) (\(index + 1)).jpg"
	}
}
