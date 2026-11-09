import MaskinDesign
import MaskinUI
import SwiftUI

/// A single-line text field on a pushed page's card, sized to the touch minimum.
struct PageTextField: View {
	let title: String
	@Binding var text: String
	var mono = false
	/// Capitalise every character (codes).
	var characters = false
	/// A URL or key: no autocapitalisation, no autocorrection, URL keyboard.
	var isURL = false
	var secure = false
	var submit: (() -> Void)?

	var body: some View {
		Group {
			if secure { SecureField(title, text: $text) } else { TextField(title, text: $text) }
		}
		.font(
			mono
				? MaskinTypeface.mono(MaskinFontSize.t16, relativeTo: .body)
				: MaskinTypeface.sans(MaskinFontSize.t16)
		)
		#if os(iOS)
			.textInputAutocapitalization(characters ? .characters : .never)
			.keyboardType(isURL ? .URL : .default)
		#endif
		.autocorrectionDisabled()
		.submitLabel(submit == nil ? .done : .continue)
		.onSubmit { submit?() }
		.padding(.horizontal, MaskinSpace.s9)
		.frame(minHeight: MaskinSpace.touchMin)
		.background(
			MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}
}
