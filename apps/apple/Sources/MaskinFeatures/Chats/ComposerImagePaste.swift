#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Lets the message field take a pasted picture. SwiftUI's `pasteDestination` is not available on iOS and the
/// field only takes text, so the keyboard's "Paste from Screenshots" and the edit menu's Paste were dropped.
/// Put this in the field's `.background`: it finds the text view behind the field, lets it accept images and
/// hands each pasted picture to `onImage`. A paste that carries text stays a plain text paste.
/// The text view is found beside this background first. On the iOS 18 selection field it does not sit there, so
/// when the field takes focus the hook also looks for the text view that is the first responder, which is the
/// one the edit menu belongs to.
struct ComposerImagePasteHook: UIViewRepresentable {
	var isFocused = false
	let onImage: @MainActor (Data) -> Void

	func makeCoordinator() -> ComposerImagePasteHandler { ComposerImagePasteHandler() }

	func makeUIView(context: Context) -> HookView {
		let view = HookView()
		view.isUserInteractionEnabled = false
		view.handler = context.coordinator
		return view
	}

	func updateUIView(_ view: HookView, context: Context) {
		context.coordinator.onImage = onImage
		view.attach(focused: isFocused)
	}

	final class HookView: UIView {
		var handler: ComposerImagePasteHandler?

		override func didMoveToWindow() {
			super.didMoveToWindow()
			attach()
		}

		/// The text view may not exist yet when this view lands in a window, so look again a few times.
		func attach(focused: Bool = false, retries: Int = 5) {
			guard let window, let handler else { return }
			var done = false
			if let input = textInput() {
				handler.install(on: input)
				done = !focused
			}
			// The keyboard may take a moment to make the text view the first responder, so this looks again too.
			if focused, let input = Self.focusedInput(in: window) {
				handler.install(on: input)
				done = true
			}
			guard !done, retries > 0 else { return }
			Task { @MainActor [weak self] in
				try? await Task.sleep(for: .milliseconds(100))
				self?.attach(focused: focused, retries: retries - 1)
			}
		}

		/// The field's text view sits beside this background in the same SwiftUI container.
		private func textInput() -> UIView? {
			var scope = superview
			for _ in 0..<3 {
				guard let current = scope else { return nil }
				if let found = Self.firstInput(in: current) { return found }
				scope = current.superview
			}
			return nil
		}

		/// The text view or text field that has the keyboard right now.
		private static func focusedInput(in view: UIView) -> UIView? {
			if view.isFirstResponder, view is UITextView || view is UITextField { return view }
			for sub in view.subviews {
				if let found = focusedInput(in: sub) { return found }
			}
			return nil
		}

		private static func firstInput(in view: UIView) -> UIView? {
			if view is UITextView || view is UITextField { return view }
			for sub in view.subviews {
				if let found = firstInput(in: sub) { return found }
			}
			return nil
		}
	}
}

@MainActor
final class ComposerImagePasteHandler: NSObject, UITextPasteDelegate {
	var onImage: @MainActor (Data) -> Void = { _ in }
	private weak var installed: UIView?

	func install(on view: UIView) {
		guard installed !== view else { return }
		installed = view
		// iOS 27.2 hands out the field's own configuration as read-only, so build a new one and set it.
		let existing = view.pasteConfiguration?.acceptableTypeIdentifiers ?? [UTType.text.identifier]
		view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: existing + [UTType.image.identifier])
		if let textView = view as? UITextView {
			textView.pasteDelegate = self
		} else if let textField = view as? UITextField {
			textField.pasteDelegate = self
		}
	}

	func textPasteConfigurationSupporting(
		_ textPasteConfigurationSupporting: any UITextPasteConfigurationSupporting, transform item: UITextPasteItem
	) {
		let provider = item.itemProvider
		// Text, or text beside a picture: keep the normal paste.
		guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), !provider.canLoadObject(ofClass: NSString.self)
		else {
			item.setDefaultResult()
			return
		}
		item.setNoResult()
		let deliver = onImage
		provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
			guard let data else { return }
			Task { @MainActor in deliver(data) }
		}
	}
}
#endif
