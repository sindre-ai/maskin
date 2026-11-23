import Foundation
import MaskinCore
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

#if os(iOS)
import UIKit
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

	@Test("several pasted images each become a chip, up to the attachment limit")
	func severalPastedImagesBecomeChips() {
		let model = ChatComposerModel(uploader: Uploader(), selfActorID: "me")
		model.attach((0..<3).map { ComposerDrop.image(Data([0xFF, 0xD8, UInt8($0)])) })
		#expect(model.attachments.count == 3)
		#expect(model.notice == nil)
		model.attach((0..<12).map { ComposerDrop.image(Data([0xFF, 0xD8, UInt8($0)])) })
		#expect(model.attachments.count == ChatLimits.maxAttachments)
		#expect(model.notice == "You can attach up to \(ChatLimits.maxAttachments) files.")
	}

	@Test("every picture on the clipboard is read in clipboard order, and text is skipped")
	func readsEveryPictureInOrder() async {
		let pictures = [Data([1, 1]), Data([2, 2]), Data([3, 3])]
		var providers = pictures.map { bytes -> NSItemProvider in
			let provider = NSItemProvider()
			provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
				done(bytes, nil)
				return nil
			}
			return provider
		}
		providers.insert(NSItemProvider(object: "just text" as NSString), at: 1)
		let loaded = await ClipboardImages.load(providers)
		#expect(loaded.images == pictures)
		#expect(loaded.unreadable == 0)
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

	@Test("an input with image paste setup offers Paste while the clipboard holds only a picture")
	func offersPasteForPicture() {
		let field = UITextField()
		ComposerImagePasteHandler().install(on: field)
		UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
			UIColor.orange.setFill()
			context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
		}
		#expect(field.canPerformAction(#selector(UIResponder.paste(_:)), withSender: nil))
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
