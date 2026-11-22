import Foundation
import MaskinCore
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

@Suite("Picking a video from the photo library")
struct AttachmentPickingTests {
	@Test("a video counts however the phone reports it")
	func videoTypes() {
		#expect(AttachmentLoading.isMovie(types: [.quickTimeMovie]))
		#expect(AttachmentLoading.isMovie(types: [.mpeg4Movie, .jpeg]))
		#expect(AttachmentLoading.isMovie(types: [.video]))
		#expect(AttachmentLoading.isMovie(types: [.audiovisualContent]))
	}

	@Test("a picture is not a video")
	func pictureTypes() {
		#expect(!AttachmentLoading.isMovie(types: [.heic, .jpeg, .png]))
		#expect(!AttachmentLoading.isMovie(types: []))
	}

	@Test("a video chip is named Video and ends in .mov, a photo chip stays Photo .jpg")
	func names() {
		let now = Date(timeIntervalSince1970: 0)
		#expect(AttachmentLoading.videoName(index: 0, now: now).hasPrefix("Video "))
		#expect(AttachmentLoading.videoName(index: 0, now: now).hasSuffix(".mov"))
		#expect(AttachmentLoading.videoName(index: 1, now: now).hasSuffix("(2).mov"))
		#expect(AttachmentLoading.photoName(index: 0, now: now).hasPrefix("Photo "))
		#expect(AttachmentLoading.photoName(index: 0, now: now).hasSuffix(".jpg"))
	}

	private struct Failure: Error, Equatable { let tag: String }

	private func file(_ name: String) -> PreparedChatFile {
		PreparedChatFile(name: name, mimeType: "video/quicktime", data: Data(count: 1))
	}

	@Test("a video reported as a picture loads as a video once the photo load fails")
	func stillFailsThenMovie() async throws {
		let result = try await AttachmentLoading.loadWithFallback(
			movieFirst: false, movie: { file("Video.mov") }, still: { throw Failure(tag: "still") })
		#expect(result.name == "Video.mov")
	}

	@Test("a picture reported as a video loads as a photo once the video load fails")
	func movieFailsThenStill() async throws {
		let result = try await AttachmentLoading.loadWithFallback(
			movieFirst: true, movie: { throw Failure(tag: "movie") }, still: { file("Photo.jpg") })
		#expect(result.name == "Photo.jpg")
	}

	@Test("the loader the type points to is not retried when it works")
	func firstWins() async throws {
		let result = try await AttachmentLoading.loadWithFallback(
			movieFirst: true, movie: { file("Video.mov") }, still: { throw Failure(tag: "unused") })
		#expect(result.name == "Video.mov")
	}

	@Test("when both fail the first loader's error is the one shown")
	func bothFail() async {
		await #expect(throws: Failure(tag: "movie")) {
			_ = try await AttachmentLoading.loadWithFallback(
				movieFirst: true, movie: { throw Failure(tag: "movie") }, still: { throw Failure(tag: "still") })
		}
	}

	@Test("a cancelled load does not start the other loader")
	func cancelledStops() async {
		await #expect(throws: CancellationError.self) {
			_ = try await AttachmentLoading.loadWithFallback(
				movieFirst: true, movie: { throw CancellationError() }, still: { file("Photo.jpg") })
		}
	}
}
