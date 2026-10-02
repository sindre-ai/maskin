import Foundation
import Testing

@testable import MaskinCore

@Suite("CronSchedule")
struct CronScheduleTests {
	@Test("describes the shapes the apps generate", arguments: [
		("0 17 * * 0", "every Sunday at 5:00 PM UTC"),
		("30 9 * * *", "every day at 9:30 AM UTC"),
		("5 * * * *", "every hour at minute 5"),
		("0 0 15 * *", "on day 15 of each month at 12:00 AM UTC"),
		("0 12 * * 7", "every Sunday at 12:00 PM UTC"),
		("15 8 * * 1", "every Monday at 8:15 AM UTC"),
	])
	func describes(expression: String, expected: String) {
		#expect(CronSchedule.describe(expression) == expected)
	}

	@Test("a leading seconds field is dropped")
	func sixFields() {
		#expect(CronSchedule(expression: "0 0 9 * * *")?.summary == "every day at 9:00 AM UTC")
	}

	@Test("syntax outside the modelled shapes falls back to the raw expression", arguments: [
		"*/5 * * * *", "0 9,15 * * *", "0 9-17 * * 1-5", "0 9 * * MON", "0 9 * 6 *",
		"* * * * *", "0 * * * 1", "60 9 * * *", "0 24 * * *", "0 9 32 * *", "nonsense", "",
		"0 9 * * 8",
	])
	func rawFallback(expression: String) {
		#expect(CronSchedule(expression: expression) == nil)
		#expect(CronSchedule.describe(expression) == expression)
	}

	@Test("expression round-trips through parse for every frequency")
	func roundTrip() {
		for schedule in [
			CronSchedule(frequency: .hourly, minute: 7),
			CronSchedule(frequency: .daily, minute: 30, hour: 18),
			CronSchedule(frequency: .weekly, minute: 0, hour: 6, dayOfWeek: 3),
			CronSchedule(frequency: .monthly, minute: 45, hour: 23, dayOfMonth: 28),
		] {
			#expect(CronSchedule(expression: schedule.expression) == schedule)
		}
	}

	private var utc: Calendar {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(secondsFromGMT: 0)!
		return c
	}

	private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Date {
		utc.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
	}

	@Test("next fire for a daily schedule is later today or tomorrow")
	func nextDaily() {
		let schedule = CronSchedule(frequency: .daily, minute: 0, hour: 9)
		#expect(schedule.nextFire(after: date(2026, 10, 1, 8, 0), calendar: utc) == date(2026, 10, 1, 9, 0))
		#expect(schedule.nextFire(after: date(2026, 10, 1, 9, 0), calendar: utc) == date(2026, 10, 2, 9, 0))
	}

	@Test("next fire for a weekly schedule lands on that weekday")
	func nextWeekly() {
		// 2026-10-02 is a Friday; Sunday is day 0.
		let schedule = CronSchedule(frequency: .weekly, minute: 0, hour: 17, dayOfWeek: 0)
		#expect(schedule.nextFire(after: date(2026, 10, 2, 12, 0), calendar: utc) == date(2026, 10, 4, 17, 0))
	}

	@Test("next fire for hourly is the next matching minute")
	func nextHourly() {
		let schedule = CronSchedule(frequency: .hourly, minute: 15)
		#expect(schedule.nextFire(after: date(2026, 10, 1, 8, 20), calendar: utc) == date(2026, 10, 1, 9, 15))
	}

	@Test("a monthly schedule on the 31st skips short months")
	func nextMonthlySkips() {
		let schedule = CronSchedule(frequency: .monthly, minute: 0, hour: 9, dayOfMonth: 31)
		// September has 30 days → next is October 31.
		#expect(schedule.nextFire(after: date(2026, 9, 5, 0, 0), calendar: utc) == date(2026, 10, 31, 9, 0))
	}
}
