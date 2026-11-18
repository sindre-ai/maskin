import Testing

@testable import MaskinFeatures

@Suite("ComposerAttachAction")
struct ComposerAttachActionTests {
	@Test("a device with a camera and an empty clipboard offers the five attach rows, then formatting")
	func everyDay() {
		let rows = ComposerAttachAction.available(hasCamera: true, clipboardHasImage: false, showsFormatting: false)
		#expect(rows == [.photo, .camera, .file, .object, .person, .showFormatting])
	}

	@Test("no camera, no Camera row")
	func noCamera() {
		let rows = ComposerAttachAction.available(hasCamera: false, clipboardHasImage: false, showsFormatting: false)
		#expect(!rows.contains(.camera))
	}

	@Test("Paste image appears only while the clipboard holds a picture")
	func pasteFollowsClipboard() {
		let withImage = ComposerAttachAction.available(hasCamera: true, clipboardHasImage: true, showsFormatting: false)
		let without = ComposerAttachAction.available(hasCamera: true, clipboardHasImage: false, showsFormatting: false)
		#expect(withImage.contains(.paste))
		#expect(!without.contains(.paste))
	}

	@Test("Paste image sits after Person or agent and before the formatting row")
	func pastePosition() {
		let rows = ComposerAttachAction.available(hasCamera: true, clipboardHasImage: true, showsFormatting: false)
		#expect(rows == [.photo, .camera, .file, .object, .person, .paste, .showFormatting])
	}

	@Test("the last row hides the formatting row while it is shown, and shows it while hidden")
	func formattingToggle() {
		let shown = ComposerAttachAction.available(hasCamera: false, clipboardHasImage: false, showsFormatting: true)
		let hidden = ComposerAttachAction.available(hasCamera: false, clipboardHasImage: false, showsFormatting: false)
		#expect(shown.last == .hideFormatting)
		#expect(hidden.last == .showFormatting)
		#expect(!shown.contains(.showFormatting))
		#expect(!hidden.contains(.hideFormatting))
	}
}
