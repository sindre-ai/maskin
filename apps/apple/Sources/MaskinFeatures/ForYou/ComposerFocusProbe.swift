import SwiftUI

#if canImport(UIKit)
import UIKit

/// Where the card sits in its window, so an editing notification can be matched to it.
@MainActor
private final class AnchorBox {
	weak var view: UIView?

	func contains(_ object: Any?) -> Bool {
		guard let field = object as? UIView, let view, view.window != nil, field.window != nil else {
			return false
		}
		let mine = view.convert(view.bounds, to: nil)
		return mine.contains(field.convert(CGPoint(x: field.bounds.midX, y: field.bounds.midY), to: nil))
	}
}

private struct AnchorView: UIViewRepresentable {
	let box: AnchorBox

	func makeUIView(context: Context) -> UIView {
		let view = UIView()
		view.isUserInteractionEnabled = false
		box.view = view
		return view
	}

	func updateUIView(_ uiView: UIView, context: Context) { box.view = uiView }
}

/// Reports whether a text field inside this view's frame is being edited. `ChatComposer` owns its
/// focus state privately, and For You's quick-question chips appear only while it is focused, so
/// this watches the system's begin/end-editing notifications and matches them by frame.
private struct ComposerFocusModifier: ViewModifier {
	@Binding var isFocused: Bool
	@State private var box = AnchorBox()

	func body(content: Content) -> some View {
		content
			.background(AnchorView(box: box))
			.onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
				if box.contains(note.object) { isFocused = true }
			}
			.onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { note in
				if box.contains(note.object) { isFocused = true }
			}
			.onReceive(NotificationCenter.default.publisher(for: UITextField.textDidEndEditingNotification)) { note in
				if box.contains(note.object) { isFocused = false }
			}
			.onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { note in
				if box.contains(note.object) { isFocused = false }
			}
	}
}

extension View {
	/// Mirrors whether a text field within this view is being edited into `isFocused`.
	func composerFocus(_ isFocused: Binding<Bool>) -> some View {
		modifier(ComposerFocusModifier(isFocused: isFocused))
	}
}
#else
extension View {
	func composerFocus(_ isFocused: Binding<Bool>) -> some View { self }
}
#endif
