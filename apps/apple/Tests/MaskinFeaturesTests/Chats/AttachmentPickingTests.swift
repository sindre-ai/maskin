import Foundation
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
}
