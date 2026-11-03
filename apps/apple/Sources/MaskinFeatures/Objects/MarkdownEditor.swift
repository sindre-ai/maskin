import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A markdown text editor with a Write / Preview switch and a formatting bar above the keyboard
/// (bold, italic, heading, list, link). The stored format stays markdown. Formatting acts on the
/// selection from iOS 18; before that it acts at the end of the text.
struct MarkdownEditor: View {
	@Binding var text: String
	var placeholder = "Write something…"

	private enum Mode: String, CaseIterable { case write = "Write", preview = "Preview" }
	@State private var mode: Mode = .write

	var body: some View {
		VStack(spacing: MaskinSpace.s5) {
			Picker("Mode", selection: $mode) {
				ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
			}
			.pickerStyle(.segmented)
			switch mode {
			case .write:
				if #available(iOS 18, macOS 15, *) {
					SelectionEditor(text: $text, placeholder: placeholder)
				} else {
					AppendEditor(text: $text, placeholder: placeholder)
				}
			case .preview:
				ScrollView {
					if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
						Text("Nothing to preview yet.").maskinText(.body).foregroundStyle(MaskinColor.ink4)
							.frame(maxWidth: .infinity, alignment: .leading)
					} else {
						MarkdownContent(text).frame(maxWidth: .infinity, alignment: .leading)
					}
				}
			}
		}
	}
}

/// The formatting buttons, shared by both editors.
private struct FormatBar: View {
	let apply: (MarkdownFormat) -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			button(.bold, "bold", "Bold")
			button(.italic, "italic", "Italic")
			button(.heading, "textformat.size", "Heading")
			button(.bullet, "list.bullet", "Bulleted list")
			button(.link, "link", "Link")
			Spacer()
		}
	}

	private func button(_ format: MarkdownFormat, _ symbol: String, _ label: String) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			apply(format)
		} label: {
			Image(systemName: symbol)
		}
		.accessibilityLabel(label)
	}
}

@available(iOS 18, macOS 15, *)
private struct SelectionEditor: View {
	@Binding var text: String
	let placeholder: String
	@State private var selection: TextSelection?

	var body: some View {
		TextEditor(text: $text, selection: $selection)
			.maskinText(.body)
			.scrollContentBackground(.hidden)
			.overlay(alignment: .topLeading) {
				if text.isEmpty {
					Text(placeholder).maskinText(.body).foregroundStyle(MaskinColor.inkPlaceholder)
						.padding(.horizontal, MaskinSpace.s3 + MaskinSpace.s1).padding(.vertical, MaskinSpace.s4)
						.allowsHitTesting(false)
				}
			}
			.toolbar { ToolbarItemGroup(placement: .keyboard) { FormatBar(apply: apply) } }
	}

	private func apply(_ format: MarkdownFormat) {
		let range = currentRange()
		let edit = MarkdownFormatting.apply(format, to: text, selection: range)
		text = edit.text
		let lo = text.index(text.startIndex, offsetBy: edit.selection.lowerBound)
		let hi = text.index(text.startIndex, offsetBy: edit.selection.upperBound)
		selection = TextSelection(range: lo..<hi)
	}

	/// The selection as character offsets; the end of the text when there is none.
	private func currentRange() -> Range<Int> {
		guard let selection, case .selection(let range) = selection.indices else {
			return text.count..<text.count
		}
		return TextOffsets.characterOffsets(of: range, in: text) ?? text.count..<text.count
	}
}

private struct AppendEditor: View {
	@Binding var text: String
	let placeholder: String

	var body: some View {
		TextEditor(text: $text)
			.maskinText(.body)
			.scrollContentBackground(.hidden)
			.toolbar {
				ToolbarItemGroup(placement: .keyboard) {
					FormatBar { format in
						text = MarkdownFormatting.apply(format, to: text, selection: text.count..<text.count).text
					}
				}
			}
	}
}
