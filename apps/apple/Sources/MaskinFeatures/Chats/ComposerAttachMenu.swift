import MaskinDesign
import SwiftUI
import UniformTypeIdentifiers

/// What the `+` offers. Spec 7 §1 → Attach: Photo or video · Camera · Scan document · File · Object · Person or agent.
/// "Paste image" joins the list only while the clipboard holds a picture: the system Paste on the field
/// takes an image too, and this row stays as a second way in. The row is the system paste button, so iOS
/// never asks "Allow Paste" for it. "Show formatting" / "Hide formatting" is
/// the last row: it opens or closes the formatting row above the bar.
enum ComposerAttachAction: String, CaseIterable, Identifiable {
	case photo, camera, scan, file, object, person, paste, showFormatting, hideFormatting

	var id: String { rawValue }

	/// The rows the `+` shows, in order. Camera needs a device camera, Paste image needs a picture on
	/// the clipboard, Scan document needs the system document scanner, and the last row flips with the
	/// formatting row's state.
	static func available(
		hasCamera: Bool, canScan: Bool = false, clipboardHasImage: Bool, showsFormatting: Bool
	) -> [ComposerAttachAction] {
		var actions: [ComposerAttachAction] = [.photo]
		if hasCamera { actions.append(.camera) }
		if canScan { actions.append(.scan) }
		actions += [.file, .object, .person]
		if clipboardHasImage { actions.append(.paste) }
		actions.append(showsFormatting ? .hideFormatting : .showFormatting)
		return actions
	}

	var label: String {
		switch self {
		case .photo: "Photo or video"
		case .camera: "Camera"
		case .scan: "Scan document"
		case .file: "File"
		case .object: "Item"
		case .person: "Person or agent"
		case .paste: "Paste image"
		case .showFormatting: "Show formatting"
		case .hideFormatting: "Hide formatting"
		}
	}

	var symbol: String {
		switch self {
		case .photo: "photo.on.rectangle"
		case .camera: "camera"
		case .scan: "doc.viewfinder"
		case .file: "doc"
		case .object: "cube"
		case .person: "person"
		case .paste: "doc.on.clipboard"
		case .showFormatting, .hideFormatting: "textformat"
		}
	}
}

/// The vertical menu the `+` opens, 8pt above the bar and left-aligned: a 250pt card with
/// 48pt rows, a 19pt `fg3` icon and a 16pt label per row.
struct ComposerAttachMenu: View {
	let actions: [ComposerAttachAction]
	/// The most height the card may take. Taller than that, the rows scroll inside it.
	var maxHeight: CGFloat = .infinity
	let onPick: (ComposerAttachAction) -> Void
	/// Gets the pictures the system paste button hands over.
	var onPasteImages: ([NSItemProvider]) -> Void = { _ in }

	static let width: CGFloat = 250
	private static let row: CGFloat = MaskinSpace.touchMin + MaskinSpace.s2
	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)

	/// The card's height with every row showing: the rows plus a 1pt separator between each.
	static func contentHeight(rows count: Int) -> CGFloat {
		CGFloat(count) * row + CGFloat(max(count - 1, 0))
	}

	/// How far to move the card, from the bar's top edge, so its bottom sits 8pt above the bar.
	static func offsetY(height: CGFloat) -> CGFloat { -(height + MaskinSpace.s4) }

	var body: some View {
		Group {
			if Self.contentHeight(rows: actions.count) > maxHeight {
				ScrollView { rows }
					.scrollBounceBehavior(.basedOnSize)
					.frame(height: maxHeight)
					.clipShape(shape)
			} else {
				rows
			}
		}
		.frame(width: Self.width)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.overlayDim.opacity(0.35), radius: MaskinSpace.s9, y: MaskinSpace.s5)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Attach")
	}

	private var rows: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(Array(actions.enumerated()), id: \.element) { index, action in
				if index > 0 { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
				if action == .paste {
					pasteRow(action)
				} else {
					pickRow(action)
				}
			}
		}
	}

	/// Paste image: the system paste button, since it reads the clipboard without the Allow Paste prompt.
	/// It keeps the system's own look, so the row only gives it the row's height and padding.
	private func pasteRow(_ action: ComposerAttachAction) -> some View {
		HStack(spacing: MaskinSpace.s7) {
			Image(systemName: action.symbol)
				.maskinSymbol(MaskinFontSize.t19, weight: .regular)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.s12)
				.accessibilityHidden(true)
			PasteButton(supportedContentTypes: [UTType.image]) { providers in
				MaskinHaptics.play(.selection)
				onPasteImages(providers)
			}
			.labelStyle(.titleOnly)
			.buttonBorderShape(.roundedRectangle)
			// The button's own title reads "Paste"; the label stays "Paste image" for VoiceOver and the must-keep test (MK-07b).
			.accessibilityLabel("Paste image")
			Spacer(minLength: 0)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(minHeight: Self.row)
	}

	private func pickRow(_ action: ComposerAttachAction) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			onPick(action)
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: action.symbol)
					.maskinSymbol(MaskinFontSize.t19, weight: .regular)
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s12)
					.accessibilityHidden(true)
				Text(action.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: Self.row)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}
}
