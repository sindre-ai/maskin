import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Which pin the comment sheet is open on.
enum FilePinTarget: Identifiable, Equatable {
	case draft
	case existing(String)

	var id: String {
		switch self {
		case .draft: "draft"
		case .existing(let id): id
		}
	}
}

/// Write or edit one pin's comment. A new pin saves on "Add comment"; an existing one can also be
/// deleted.
struct PinCommentSheet: View {
	let number: Int
	let selector: String
	let isNew: Bool
	let onSave: (String) -> Void
	let onDelete: (() -> Void)?

	@State private var text: String
	@FocusState private var focused: Bool
	@Environment(\.dismiss) private var dismiss

	init(
		number: Int, selector: String, initialComment: String, isNew: Bool,
		onSave: @escaping (String) -> Void, onDelete: (() -> Void)?
	) {
		self.number = number
		self.selector = selector
		self.isNew = isNew
		self.onSave = onSave
		self.onDelete = onDelete
		_text = State(initialValue: initialComment)
	}

	private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
	private var remaining: Int { FileAnnotationRules.maxComment - text.count }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			HStack(spacing: MaskinSpace.s5) {
				FilePinMarker(number: number, isDraft: isNew).frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.allowsHitTesting(false)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(isNew ? "New comment" : "Pin \(number)").maskinText(.headline).foregroundStyle(MaskinColor.ink)
					if !selector.isEmpty {
						Text(selector).maskinText(.mono).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
				}
				Spacer(minLength: 0)
			}

			TextField("Add a comment…", text: $text, axis: .vertical)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(3...8)
				.focused($focused)
				.padding(MaskinSpace.s9)
				.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				.onChange(of: text) { _, new in
					if new.count > FileAnnotationRules.maxComment {
						text = String(new.prefix(FileAnnotationRules.maxComment))
					}
				}

			HStack {
				if remaining < 80 {
					Text("\(remaining) left").maskinText(.caption).foregroundStyle(remaining < 0 ? MaskinColor.danger : MaskinColor.ink4)
				}
				Spacer()
			}

			Button(isNew ? "Add comment" : "Save") {
				onSave(trimmed)
				dismiss()
			}
			.buttonStyle(.primaryAction)
			.disabled(trimmed.isEmpty)

			if let onDelete {
				Button(role: .destructive) {
					onDelete()
					dismiss()
				} label: {
					Text("Delete pin").maskinText(.headline).frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				}
				.foregroundStyle(MaskinColor.danger)
			}
		}
		.padding(MaskinSpace.s11)
		.frame(maxHeight: .infinity, alignment: .top)
		.background(MaskinSurface.grouped)
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
		.onAppear { focused = true }
	}
}
