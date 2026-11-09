import MaskinDesign
import MaskinUI
import SwiftUI

/// The one Display sheet Items, Flows, Chats and Agents share (handoff v15, item 2): a title with
/// Reset in the header, then sections (ORDERING, GROUPING, FILTERS, PROPERTIES) of labelled chip
/// rows. Chips, not segments. The content scrolls inside the sheet; a screen fills it with
/// `DisplaySection`s and passes whether anything is off its default so Reset only shows then.
struct DisplaySheet<Content: View>: View {
	var canReset: Bool
	var onReset: () -> Void
	@ViewBuilder var content: Content
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .firstTextBaseline) {
				Text("Display")
					.maskinText(.title)
					.fontWeight(.bold)
					.foregroundStyle(MaskinColor.ink)
					.accessibilityAddTraits(.isHeader)
				Spacer(minLength: MaskinSpace.s5)
				if canReset {
					Button("Reset") {
						MaskinHaptics.play(.selection)
						onReset()
					}
					.maskinText(.body).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.sigInk)
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.top, MaskinSpace.s9)
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s9) {
					content
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s5)
			}
		}
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}
}

/// A titled run of chip rows with a hairline above it (the first section has none).
struct DisplaySection<Content: View>: View {
	let title: String?
	var showsDivider = true
	@ViewBuilder var content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			if showsDivider { Divider().overlay(MaskinSurface.line) }
			if let title { MonoLabel(title, color: MaskinColor.ink4, size: .section) }
			content
		}
	}
}

/// One labelled row of single-choice chips ("Sort by", "Group by", a status filter).
struct DisplayChoice<Value: Hashable>: View {
	let label: String
	let options: [(value: Value, title: String)]
	@Binding var selection: Value

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(label).maskinText(.subhead).fontWeight(.medium).foregroundStyle(MaskinColor.ink4)
			ChipFlow(spacing: MaskinSpace.s4) {
				ForEach(options.indices, id: \.self) { index in
					let option = options[index]
					DisplayChip(title: option.title, isOn: option.value == selection) {
						selection = option.value
					}
				}
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel(label)
	}
}

/// A labelled row of independent on/off chips (the PROPERTIES "Show" row).
struct DisplayToggles: View {
	let label: String
	let items: [Item]

	struct Item: Identifiable {
		let id: String
		let title: String
		let isOn: Binding<Bool>
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(label).maskinText(.subhead).fontWeight(.medium).foregroundStyle(MaskinColor.ink4)
			ChipFlow(spacing: MaskinSpace.s4) {
				ForEach(items) { item in
					DisplayChip(title: item.title, isOn: item.isOn.wrappedValue) {
						item.isOn.wrappedValue.toggle()
					}
				}
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel(label)
	}
}

/// The chip: ink fill with inverse text when chosen, a hairline outline when not. 44 pt hit area.
struct DisplayChip: View {
	let title: String
	let isOn: Bool
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Text(title)
				.maskinText(.body)
				.fontWeight(.semibold)
				.foregroundStyle(isOn ? MaskinSurface.onInverse : MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s9)
				.frame(minHeight: MaskinSpace.touchMin)
				.background(isOn ? MaskinSurface.inverse : Color.clear, in: Capsule())
				.overlay(Capsule().strokeBorder(isOn ? Color.clear : MaskinSurface.line, lineWidth: 1))
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityAddTraits(isOn ? .isSelected : [])
	}
}
