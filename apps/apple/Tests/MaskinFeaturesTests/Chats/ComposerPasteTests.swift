import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@MainActor
@Suite("Pasting into the composer")
struct ComposerPasteTests {
	private struct Uploader: ChatFileUploading {
		func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
			ChatAttachmentRef(fileID: "f-\(name)", name: name, mimeType: mimeType, sizeBytes: data.count)
		}
	}

	@Test("a pasted image becomes an image chip")
	func pastedImageBecomesChip() {
		let model = ChatComposerModel(uploader: Uploader(), selfActorID: "me")
		model.attach([.image(Data([0xFF, 0xD8, 0xFF]))])
		#expect(model.attachments.count == 1)
		#expect(model.attachments.first?.isImage == true)
		#expect(model.text.isEmpty)
	}

	@Test("the + menu no longer has a Paste image row")
	func noPasteRow() {
		#expect(!ComposerAttachAction.allCases.map(\.label).contains("Paste image"))
	}
}
