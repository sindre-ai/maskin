import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The row of formatting buttons above the message box: bold, italic, strikethrough, link, bulleted
/// list, numbered list, quote, inline code, code block (the web's set and order). Each button runs
/// `ChatComposerModel.applyFormat`, so it acts on the selection from iOS 18 and at the end of the
/// text before that. The row scrolls sideways when it is wider than the screen.
struct ComposerFormatBar: View {
	let onFormat: (MarkdownFormat) -> Void

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 0) {
				ForEach(ComposerFormatting.formats, id: \.self) { format in
					Button {
						MaskinHaptics.play(.selection)
						onFormat(format)
					} label: {
						Image(systemName: Self.symbol(format))
							.maskinSymbol(MaskinFontSize.t17, weight: .regular)
							.foregroundStyle(MaskinColor.ink3)
							.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel(Self.label(format))
				}
			}
			.padding(.horizontal, MaskinSpace.s1)
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Formatting")
	}

	static func label(_ format: MarkdownFormat) -> String {
		switch format {
		case .bold: "Bold"
		case .italic: "Italic"
		case .strikethrough: "Strikethrough"
		case .link: "Link"
		case .bullet: "Bulleted list"
		case .numbered: "Numbered list"
		case .quote: "Quote"
		case .code: "Inline code"
		case .codeBlock: "Code block"
		case .heading: "Heading"
		}
	}

	static func symbol(_ format: MarkdownFormat) -> String {
		switch format {
		case .bold: "bold"
		case .italic: "italic"
		case .strikethrough: "strikethrough"
		case .link: "link"
		case .bullet: "list.bullet"
		case .numbered: "list.number"
		case .quote: "text.quote"
		case .code: "chevron.left.forwardslash.chevron.right"
		case .codeBlock: "curlybraces"
		case .heading: "textformat.size"
		}
	}
}
