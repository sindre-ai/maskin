import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Composer formatting row")
struct ComposerFormattingTests {
	private func defaults() -> UserDefaults {
		let name = "ComposerFormattingTests.\(UUID().uuidString)"
		let defaults = UserDefaults(suiteName: name)!
		defaults.removePersistentDomain(forName: name)
		return defaults
	}

	@Test("hidden by default, remembered once chosen, and kept per person")
	func remembered() {
		let store = defaults()
		#expect(!ComposerFormatting.isShown(actorID: "me", defaults: store))
		ComposerFormatting.setShown(true, actorID: "me", defaults: store)
		#expect(ComposerFormatting.isShown(actorID: "me", defaults: store))
		#expect(!ComposerFormatting.isShown(actorID: "sam", defaults: store))
		ComposerFormatting.setShown(false, actorID: "me", defaults: store)
		#expect(!ComposerFormatting.isShown(actorID: "me", defaults: store))
	}

	@Test("offers the web's nine formats and no headings")
	func formats() {
		#expect(ComposerFormatting.formats.count == 9)
		#expect(!ComposerFormatting.formats.contains(.heading))
	}

	@Test("a format button wraps the selected word, so the sent text carries the markers")
	func boldOnSelection() {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = "make this word bold"
		model.selection = 10..<14
		model.applyFormat(.bold)
		#expect(model.text == "make this **word** bold")
		#expect(model.take()?.text == "make this **word** bold")
	}
}
