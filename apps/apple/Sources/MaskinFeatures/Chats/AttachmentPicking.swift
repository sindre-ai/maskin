import Foundation
import MaskinCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

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

/// A video from the picker, copied to a temp file.
struct PickedMovieFile: Transferable {
	let url: URL

	static var transferRepresentation: some TransferRepresentation {
		FileRepresentation(importedContentType: .movie) { received in
			let name = "\(UUID().uuidString)-\(received.file.lastPathComponent)"
			let destination = FileManager.default.temporaryDirectory.appendingPathComponent(name)
			try FileManager.default.copyItem(at: received.file, to: destination)
			return PickedMovieFile(url: destination)
		}
	}
}

/// Something pasted into or dropped onto the composer bar: a picture, or any file.
enum ComposerDrop: Transferable {
	case image(Data)
	case file(URL)

	static var transferRepresentation: some TransferRepresentation {
		DataRepresentation(importedContentType: .image) { ComposerDrop.image($0) }
		FileRepresentation(importedContentType: .item) { received in
			let name = received.file.lastPathComponent
			let destination = FileManager.default.temporaryDirectory
				.appendingPathComponent(UUID().uuidString, isDirectory: true)
			try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
			let copy = destination.appendingPathComponent(name)
			try FileManager.default.copyItem(at: received.file, to: copy)
			return ComposerDrop.file(copy)
		}
	}
}

extension ChatComposerModel {
	/// Chips for what was pasted into or dropped on the bar: a picture, or any file.
	func attach(_ drops: [ComposerDrop]) {
		for drop in drops {
			switch drop {
			case .image(let data):
				let name = "Pasted image.jpg"
				attach(name: name, mimeType: "image/jpeg", prepare: AttachmentLoading.image(data: data, name: name))
			case .file(let url):
				attach(
					name: url.lastPathComponent, mimeType: AttachmentLoading.mimeType(for: url),
					prepare: AttachmentLoading.file(at: url, deleteAfter: true))
			}
		}
	}
}

/// PhotosPickerItem is not declared Sendable; it is only ever used from the one loading task.
private struct ItemBox: @unchecked Sendable { let item: PhotosPickerItem }

#if os(iOS)
/// UIImage is not declared Sendable; the pages are only read by the one task that builds the PDF.
private struct ScanPagesBox: @unchecked Sendable { let pages: [UIImage] }
#endif

enum AttachmentLoading {
	/// True when the picker item is a video rather than a picture.
	static func isMovie(_ item: PhotosPickerItem) -> Bool { isMovie(types: item.supportedContentTypes) }

	/// The picker reports a video as a movie, a video or plain audiovisual content, depending on how it
	/// was recorded or shared, so any of them counts.
	static func isMovie(types: [UTType]) -> Bool {
		types.contains { $0.conforms(to: .movie) || $0.conforms(to: .video) || $0.conforms(to: .audiovisualContent) }
	}

	/// A photo or a video from the picker. Pictures are downsampled; a video is sent as it is, if it
	/// is under the size cap. One too big for the JSON route stays on disk and goes up in parts.
	/// The item's reported type picks the first try; when that fails the other way is tried before the
	/// person sees an error, since a video the phone reports as a picture still plays as a video.
	static func media(_ item: PhotosPickerItem, index: Int) -> @Sendable () async throws -> PreparedChatFile {
		let box = ItemBox(item: item)
		let stillName = photoName(index: index)
		let clipName = videoName(index: index)
		let movieFirst = isMovie(item)
		return {
			try await loadWithFallback(
				movieFirst: movieFirst, movie: { try await loadMovie(box, name: clipName) },
				still: { try await loadPhoto(box, name: stillName) })
		}
	}

	/// Tries the loader the type points to; when that fails the other one gets a go before the person sees
	/// an error. If both fail, the first loader's error is the one shown.
	static func loadWithFallback(
		movieFirst: Bool, movie: () async throws -> PreparedChatFile, still: () async throws -> PreparedChatFile
	) async throws -> PreparedChatFile {
		if movieFirst { return try await attempt(movie, then: still) }
		return try await attempt(still, then: movie)
	}

	private static func attempt(
		_ first: () async throws -> PreparedChatFile, then second: () async throws -> PreparedChatFile
	) async throws -> PreparedChatFile {
		do {
			return try await first()
		} catch {
			if error is CancellationError { throw error }
			guard let other = try? await second() else { throw error }
			return other
		}
	}

	private static func loadPhoto(_ box: ItemBox, name: String) async throws -> PreparedChatFile {
		let picked: PickedImageFile?
		do {
			picked = try await box.item.loadTransferable(type: PickedImageFile.self)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			throw ChatAttachmentError("Couldn't read that photo.")
		}
		guard let picked else { throw ChatAttachmentError("Couldn't read that photo.") }
		defer { try? FileManager.default.removeItem(at: picked.url) }
		guard let result = ImageDownsampler.prepare(fileAt: picked.url) else {
			throw ChatAttachmentError("That photo can't be attached.")
		}
		let base = (name as NSString).deletingPathExtension
		return PreparedChatFile(name: "\(base).\(result.fileExtension)", mimeType: result.mimeType, data: result.data)
	}

	private static func loadMovie(_ box: ItemBox, name: String) async throws -> PreparedChatFile {
		let picked: PickedMovieFile?
		do {
			picked = try await box.item.loadTransferable(type: PickedMovieFile.self)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			throw ChatAttachmentError("Couldn't read that video.")
		}
		guard let picked else { throw ChatAttachmentError("Couldn't read that video.") }
		// The composer removes the file itself once a large one has been uploaded.
		var handedOff = false
		defer { if !handedOff { try? FileManager.default.removeItem(at: picked.url) } }
		let size = (try? picked.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		guard size <= ChatLimits.maxFileBytes else { throw ChatAttachmentError("Over the 5 GB limit.") }
		let base = (name as NSString).deletingPathExtension
		let ext = picked.url.pathExtension.isEmpty ? "mov" : picked.url.pathExtension
		let mime = mimeType(for: picked.url)
		if FileUploadLimits.needsDirectUpload(sizeBytes: size, mimeType: mime) {
			handedOff = true
			return PreparedChatFile(name: "\(base).\(ext)", mimeType: mime, fileURL: picked.url, sizeBytes: size)
		}
		let data = try Data(contentsOf: picked.url, options: .mappedIfSafe)
		return PreparedChatFile(name: "\(base).\(ext)", mimeType: mime, data: data)
	}

	/// A picture already in memory (a camera shot, an image pasted from the clipboard): written to a temp
	/// file and sent through the same downsampling as a library photo.
	static func image(data: Data, name: String) -> @Sendable () async throws -> PreparedChatFile {
		{
			let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
			try data.write(to: url)
			defer { try? FileManager.default.removeItem(at: url) }
			guard let result = ImageDownsampler.prepare(fileAt: url) else {
				throw ChatAttachmentError("Couldn't read that image (\(data.count) bytes).")
			}
			let base = (name as NSString).deletingPathExtension
			return PreparedChatFile(
				name: "\(base).\(result.fileExtension)", mimeType: result.mimeType, data: result.data)
		}
	}

	/// Pages from the document scanner, drawn into one PDF. Done inside the task, off the main thread.
	#if os(iOS)
	static func scan(pages: [UIImage], name: String) -> @Sendable () async throws -> PreparedChatFile {
		let box = ScanPagesBox(pages: pages)
		return {
			guard let data = ScannedDocument.pdf(from: box.pages) else {
				throw ChatAttachmentError("Couldn't make a PDF from that scan.")
			}
			return PreparedChatFile(name: name, mimeType: "application/pdf", data: data)
		}
	}
	#endif

	/// A file from the Files picker, or one dropped on the bar (`deleteAfter` removes our temp copy).
	/// Size is checked before a single byte is read. One too big for the JSON route is copied to our
	/// own temp file (the picked one is only readable inside the security scope) and goes up in parts.
	static func file(at url: URL, deleteAfter: Bool = false) -> @Sendable () async throws -> PreparedChatFile {
		{
			let scoped = url.startAccessingSecurityScopedResource()
			defer {
				if scoped { url.stopAccessingSecurityScopedResource() }
				if deleteAfter { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
			}
			let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
			guard size <= ChatLimits.maxFileBytes else {
				throw ChatAttachmentError("Over the 5 GB limit.")
			}
			let mime = mimeType(for: url)
			if FileUploadLimits.needsDirectUpload(sizeBytes: size, mimeType: mime) {
				let copy = FileManager.default.temporaryDirectory
					.appendingPathComponent(UUID().uuidString).appendingPathExtension(url.pathExtension)
				try FileManager.default.copyItem(at: url, to: copy)
				return PreparedChatFile(name: url.lastPathComponent, mimeType: mime, fileURL: copy, sizeBytes: size)
			}
			let data = try Data(contentsOf: url, options: .mappedIfSafe)
			return PreparedChatFile(name: url.lastPathComponent, mimeType: mime, data: data)
		}
	}

	static func mimeType(for url: URL) -> String {
		UTType(filenameExtension: url.pathExtension)?.preferredMIMEType?.lowercased()
			?? "application/octet-stream"
	}

	static func photoName(index: Int, now: Date = Date()) -> String {
		let time = stamp(now)
		return index == 0 ? "Photo \(time).jpg" : "Photo \(time) (\(index + 1)).jpg"
	}

	static func videoName(index: Int, now: Date = Date()) -> String {
		let time = stamp(now)
		return index == 0 ? "Video \(time).mov" : "Video \(time) (\(index + 1)).mov"
	}

	private static func stamp(_ now: Date) -> String {
		now.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute())
			.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
	}
}
