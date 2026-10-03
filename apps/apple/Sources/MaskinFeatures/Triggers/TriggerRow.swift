import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One trigger in the list, on a single line: kind glyph, name, the agent it runs and an inline
/// on/off switch. The plain-language summary lives on the trigger's detail.
struct TriggerRow: View {
	let trigger: Trigger
	let agentName: String
	let onToggle: (Bool) -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: trigger.kind.symbol)
				.font(.system(size: MaskinSpace.s8, weight: .semibold))
				.foregroundStyle(trigger.enabled ? MaskinColor.accentFgStrong : MaskinColor.ink5)
				.frame(width: MaskinSpace.s9)
				.accessibilityHidden(true)
			Text(trigger.name)
				.maskinText(.subhead)
				.foregroundStyle(trigger.enabled ? MaskinColor.ink : MaskinColor.ink4)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s3)
			Text(agentName)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
				.lineLimit(1)
				.accessibilityHidden(true)
			Toggle(
				"Enabled",
				isOn: Binding(get: { trigger.enabled }, set: onToggle)
			)
			.labelsHidden()
			.controlSize(.small)
			.accessibilityLabel("\(trigger.name) enabled")
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .contain)
	}
}
