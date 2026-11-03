import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Add property", opened from the Properties card on an item (handoff 1i): name, type, then the
/// value. Saving adds the property to the item's type for the workspace, then sets it on this item.
struct AddPropertySheet: View {
	@Environment(\.dismiss) private var dismiss
	let store: ObjectDetailStore
	let schema: SchemaStore
	let type: String

	@State private var name = ""
	@State private var kind: PropertyDefinition.Kind = .text
	@State private var choicesText = ""
	@State private var text = ""
	@State private var date = Date()
	@State private var hasDate = false
	@State private var flag = false
	@State private var chosen = ""
	@State private var isSaving = false
	@State private var error: String?

	private var draft: PropertyDefinition {
		PropertyDefinition(name: name, kind: kind, values: SchemaStore.parseValues(choicesText))
	}

	private var value: String? {
		switch kind {
		case .text, .number: PropertyValueEncoding.normalized(text, kind: kind)
		case .date: hasDate ? PropertyValueEncoding.dateString(date) : nil
		case .boolean: PropertyValueEncoding.boolString(flag)
		case .enum: draft.values.contains(chosen) ? chosen : nil
		}
	}

	private var canSave: Bool {
		!isSaving && schema.problem(with: draft, on: type) == nil && value != nil
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Name") {
					TextField("Budget", text: $name)
						.autocorrectionDisabled()
						.frame(minHeight: MaskinSpace.touchMin)
				}
				Section("Type") {
					LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: MaskinSpace.s4), count: 3), spacing: MaskinSpace.s4) {
						ForEach(PropertyDefinition.Kind.allCases, id: \.self) { option in typeTile(option) }
					}
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					if kind == .enum {
						TextField("Choices, separated by commas", text: $choicesText)
							.autocorrectionDisabled()
					}
				}
				Section("Value") { valueField }
				if let error { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle("Add property")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Add property") { Task { await save() } }.disabled(!canSave)
				}
			}
			.task { await schema.load() }
		}
		.presentationDetents([.medium, .large])
	}

	/// The tile labels follow the handoff ("Select", "Checkbox") rather than the settings wording.
	private static func tileLabel(_ kind: PropertyDefinition.Kind) -> String {
		switch kind {
		case .text: "Text"
		case .number: "Number"
		case .date: "Date"
		case .enum: "Select"
		case .boolean: "Checkbox"
		}
	}

	private static func tileSymbol(_ kind: PropertyDefinition.Kind) -> String {
		switch kind {
		case .text: "text.alignleft"
		case .number: "number"
		case .date: "calendar"
		case .enum: "square.stack.3d.up"
		case .boolean: "checkmark"
		}
	}

	private func typeTile(_ option: PropertyDefinition.Kind) -> some View {
		let on = option == kind
		return Button {
			MaskinHaptics.play(.selection)
			kind = option
		} label: {
			VStack(spacing: MaskinSpace.s3) {
				Image(systemName: Self.tileSymbol(option)).maskinSymbol(MaskinFontSize.t17, weight: .regular)
				Text(Self.tileLabel(option)).maskinText(.caption).fontWeight(.semibold)
			}
			.foregroundStyle(on ? MaskinColor.accentFgStrong : MaskinColor.ink2)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s11)
			.background(on ? MaskinColor.accentTint : MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
					.strokeBorder(on ? MaskinColor.accent : MaskinSurface.line, lineWidth: on ? 2 : 1))
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(Self.tileLabel(option))
		.accessibilityAddTraits(on ? .isSelected : [])
	}

	@ViewBuilder private var valueField: some View {
		switch kind {
		case .text:
			TextField("Value", text: $text).frame(minHeight: MaskinSpace.touchMin)
		case .number:
			TextField("0", text: $text)
				#if os(iOS)
					.keyboardType(.decimalPad)
				#endif
				.frame(minHeight: MaskinSpace.touchMin)
		case .date:
			Toggle("Set a date", isOn: $hasDate)
			if hasDate { DatePicker("Date", selection: $date, displayedComponents: .date) }
		case .boolean:
			Toggle("Yes", isOn: $flag)
		case .enum:
			if draft.values.isEmpty {
				Text("Add choices above, then pick one.").foregroundStyle(MaskinColor.ink4)
			} else {
				Picker("Value", selection: $chosen) {
					Text("Choose").tag("")
					ForEach(draft.values, id: \.self) { Text($0).tag($0) }
				}
			}
		}
	}

	private func save() async {
		guard let value else { return }
		isSaving = true
		defer { isSaving = false }
		guard await schema.addProperty(draft, to: type) else {
			error = schema.actionError ?? "Couldn't add the property."
			return
		}
		await store.setProperty(SchemaStore.normalizedName(name), value)
		dismiss()
	}
}
