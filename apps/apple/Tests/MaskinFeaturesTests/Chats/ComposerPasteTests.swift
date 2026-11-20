import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

#if os(iOS)
import UIKit
import UniformTypeIdentifiers
#endif

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

	@Test("the + menu keeps its Paste image row")
	func pasteRowStays() {
		#expect(ComposerAttachAction.allCases.map(\.label).contains("Paste image"))
	}

	#if os(iOS)
	@Test("image paste setup leaves a read-only paste configuration alone and sets a new one")
	func installOnReadOnlyConfiguration() {
		let field = ReadOnlyPasteTextView()
		ComposerImagePasteHandler().install(on: field)
		let types = field.pasteConfiguration?.acceptableTypeIdentifiers ?? []
		#expect(!field.readOnly.wasChanged)
		#expect(types.contains(UTType.text.identifier))
		#expect(types.contains(UTType.image.identifier))
	}
	#endif
}

#if os(iOS)
/// Stands in for the list iOS 27.2 hands out: it can be read, and any change to it is refused.
private final class ReadOnlyPasteConfiguration: UIPasteConfiguration {
	private(set) var wasChanged = false

	override func addAcceptableTypeIdentifiers(_ acceptableTypeIdentifiers: [String]) {
		wasChanged = true
	}
}

private final class ReadOnlyPasteTextView: UITextView {
	let readOnly = ReadOnlyPasteConfiguration(acceptableTypeIdentifiers: [UTType.text.identifier])
	private var replacement: UIPasteConfiguration?

	override var pasteConfiguration: UIPasteConfiguration? {
		get { replacement ?? readOnly }
		set { replacement = newValue }
	}
}
#endif
