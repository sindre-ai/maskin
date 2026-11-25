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

	private func fileProvider(named name: String, type: UTType, contents: Data) throws -> NSItemProvider {
		let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let source = folder.appendingPathComponent(name)
		try contents.write(to: source)
		let provider = NSItemProvider()
		provider.suggestedName = (name as NSString).deletingPathExtension
		provider.registerFileRepresentation(forTypeIdentifier: type.identifier, fileOptions: [], visibility: .all) { done in
			done(source, false, nil)
			return nil
		}
		return provider
	}

	@Test("a copied PDF counts as a file, text and pictures do not")
	func recognisesFileItems() throws {
		let pdf = try fileProvider(named: "Statement.pdf", type: .pdf, contents: Data([0x25, 0x50]))
		#expect(ClipboardFiles.isFile(pdf))
		#expect(!ClipboardFiles.isFile(NSItemProvider(object: "just text" as NSString)))
		let picture = NSItemProvider()
		picture.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
			done(Data([1]), nil)
			return nil
		}
		#expect(!ClipboardFiles.isFile(picture))
		#expect(ClipboardFiles.holdsFile(types: [UTType.pdf.identifier]))
		#expect(!ClipboardFiles.holdsFile(types: [UTType.utf8PlainText.identifier, UTType.png.identifier]))
	}

	@Test("every file on the clipboard is read in order and keeps its name")
	func readsEveryFileKeepingNames() async throws {
		let first = try fileProvider(named: "Statement.pdf", type: .pdf, contents: Data([1, 2, 3]))
		let second = try fileProvider(named: "Notes.pdf", type: .pdf, contents: Data([4, 5]))
		let loaded = await ClipboardFiles.load([first, NSItemProvider(object: "text" as NSString), second])
		#expect(loaded.unreadable == 0)
		#expect(loaded.files.map(\.lastPathComponent) == ["Statement.pdf", "Notes.pdf"])
		#expect(try Data(contentsOf: loaded.files[0]) == Data([1, 2, 3]))
	}

	@Test("a copied file with no extension gets the one its type has")
	func addsMissingExtension() async throws {
		let provider = try fileProvider(named: "Statement", type: .pdf, contents: Data([1]))
		let loaded = await ClipboardFiles.load([provider])
		#expect(loaded.files.map(\.lastPathComponent) == ["Statement.pdf"])
	}

	@Test("a pasted file becomes a chip under its own name, up to the attachment limit")
	func pastedFileBecomesChip() async throws {
		let model = ChatComposerModel(uploader: Uploader(), selfActorID: "me")
		let provider = try fileProvider(named: "Statement.pdf", type: .pdf, contents: Data([1, 2, 3]))
		let loaded = await ClipboardFiles.load([provider])
		model.attach(loaded.files.map { ComposerDrop.file($0) })
		#expect(model.attachments.count == 1)
		#expect(model.attachments.first?.name == "Statement.pdf")
		#expect(model.attachments.first?.mimeType == "application/pdf")
		#expect(model.attachments.first?.isImage == false)
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

	@Test("file paste setup lets the input accept files beside text and pictures")
	func installAcceptsFiles() {
		let field = UITextView()
		ComposerImagePasteHandler().install(on: field)
		let types = field.pasteConfiguration?.acceptableTypeIdentifiers ?? []
		#expect(types.contains(UTType.data.identifier))
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
