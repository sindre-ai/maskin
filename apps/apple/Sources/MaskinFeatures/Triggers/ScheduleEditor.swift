import MaskinCore
import MaskinDesign
import SwiftUI

/// Form rows for choosing a schedule: how often, on which day, at what time. The server runs
/// schedules in UTC, so every day and time here is UTC; the viewer's local equivalent is shown
/// beneath as a hint.
struct ScheduleEditor: View {
	@Binding var schedule: CronSchedule

	var body: some View {
		Picker("Repeats", selection: $schedule.frequency) {
			ForEach(CronSchedule.Frequency.allCases) { Text($0.label).tag($0) }
		}
		if schedule.frequency == .weekly {
			Picker("On", selection: $schedule.dayOfWeek) {
				ForEach(0..<7, id: \.self) { Text(CronSchedule.dayName($0)).tag($0) }
			}
		}
		if schedule.frequency == .monthly {
			Stepper("Day \(schedule.dayOfMonth) of the month", value: $schedule.dayOfMonth, in: 1...31)
		}
		if schedule.frequency == .hourly {
			Stepper("At minute \(schedule.minute)", value: $schedule.minute, in: 0...59)
		} else {
			DatePicker("At (UTC)", selection: timeBinding, displayedComponents: .hourAndMinute)
				.environment(\.calendar, CronSchedule.utcCalendar)
				.environment(\.timeZone, CronSchedule.utcCalendar.timeZone)
		}
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(schedule.summary.prefix(1).uppercased() + schedule.summary.dropFirst())
			if let local = schedule.localEquivalent(after: Date()) {
				Text("Next run at \(local) your time")
			}
		}
		.maskinText(.caption)
		.foregroundStyle(MaskinColor.ink4)
	}

	/// The schedule's hour and minute as a `Date` on a fixed day, for `DatePicker`.
	private var timeBinding: Binding<Date> {
		Binding(
			get: {
				CronSchedule.utcCalendar.date(
					bySettingHour: schedule.hour, minute: schedule.minute, second: 0, of: Date())
					?? Date()
			},
			set: { date in
				let parts = CronSchedule.utcCalendar.dateComponents([.hour, .minute], from: date)
				schedule.hour = parts.hour ?? schedule.hour
				schedule.minute = parts.minute ?? schedule.minute
			})
	}
}

/// "Run as" agent picker rows shared by the create sheet and the detail screen.
struct AgentPicker: View {
	let title: String
	let agents: [AutomationActor]
	@Binding var selection: String?

	var body: some View {
		Picker(title, selection: $selection) {
			if selection == nil { Text("Choose an agent").tag(String?.none) }
			ForEach(agents) { Text($0.name).tag(String?.some($0.id)) }
		}
	}
}
