import MaskinDesign
import SwiftUI

/// What the `+` offers. Spec 7 §1 → Attach: Photo or video · Camera · File · Object · Person or agent.
/// "Paste image" joins the list only while the clipboard holds a picture (the one way to paste an
/// image into the bar on iPhone).
enum ComposerAttachAction: String, CaseIterable, Identifiable {
	case photo, camera, file, object, person, paste

	var id: String { rawValue }

	var label: String {
		switch self {
		case .photo: "Photo or video"
		case .camera: "Camera"
		case .file: "File"
		case .object: "Object"
		case .person: "Person or agent"
		case .paste: "Paste image"
		}
	}

	var symbol: String {
		switch self {
		case .photo: "photo.on.rectangle"
		case .camera: "camera"
		case .file: "doc"
		case .object: "cube"
		case .person: "person"
		case .paste: "doc.on.clipboard"
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

	static let width: CGFloat = 250
	private static let row: CGFloat = MaskinSpace.touchMin + MaskinSpace.s2
	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)

	/// The card's height with every row showing: the rows plus a 1pt separator between each.
	static func contentHeight(rows count: Int) -> CGFloat {
		CGFloat(count) * row + CGFloat(max(count - 1, 0))
	}

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
	}
}
