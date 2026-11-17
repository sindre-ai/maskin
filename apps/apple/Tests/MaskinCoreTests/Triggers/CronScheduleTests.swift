import Foundation
import Testing

@testable import MaskinCore

@Suite("CronSchedule")
struct CronScheduleTests {
	private var utc: Calendar {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(secondsFromGMT: 0)!
		return c
	}

	private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> Date {
		utc.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
	}

	// The server runs schedules in UTC; lists show Copenhagen time like the web list.
	// Winter is CET (UTC+1), summer is CEST (UTC+2).
	private var winter: Date { date(2026, 1, 5, 8, 0) }
	private var summer: Date { date(2026, 7, 6, 8, 0) }

	@Test("describes the shapes the apps generate in Copenhagen winter time", arguments: [
		("0 17 * * 0", "every Sunday at 18:00"),
		("30 9 * * *", "every day at 10:30"),
		("5 * * * *", "every hour at minute 5"),
		("0 0 15 * *", "on day 15 of each month at 01:00"),
		("0 12 * * 7", "every Sunday at 13:00"),
		("15 8 * * 1", "every Monday at 09:15"),
		("0 23 * * *", "every day at 00:00"),
	])
	func describesWinter(expression: String, expected: String) {
		#expect(CronSchedule.describe(expression, now: winter) == expected)
	}

	@Test("describes the shapes the apps generate in Copenhagen summer time", arguments: [
		("0 17 * * 0", "every Sunday at 19:00"),
		("30 9 * * *", "every day at 11:30"),
		("0 8 15 * *", "on day 15 of each month at 10:00"),
	])
	func describesSummer(expression: String, expected: String) {
		#expect(CronSchedule.describe(expression, now: summer) == expected)
	}

	@Test("a weekly or monthly schedule takes the new day when the conversion crosses midnight")
	func crossesMidnight() {
		// Sunday 23:00 UTC is Monday 00:00 CET and Monday 01:00 CEST.
		#expect(CronSchedule.describe("0 23 * * 0", now: winter) == "every Monday at 00:00")
		#expect(CronSchedule.describe("0 23 * * 0", now: summer) == "every Monday at 01:00")
		// The 31st at 23:00 UTC is the 1st at 00:00 CET.
		#expect(CronSchedule.describe("0 23 31 * *", now: winter) == "on day 1 of each month at 00:00")
	}

	@Test("a fixed day and month reads as a one-time date")
	func oneTime() {
		let october = date(2026, 10, 20, 8, 0)
		#expect(CronSchedule.describe("0 8 3 11 *", now: october) == "once on 3 Nov at 09:00")
		#expect(CronSchedule.describe("0 8 1 7 *", now: winter) == "once on 1 Jul at 10:00")
		// Past this year's date, so the next one is next year and the year is shown.
		#expect(
			CronSchedule.describe("0 8 3 11 *", now: date(2026, 11, 17, 8, 0)) == "once on 3 Nov 2027 at 09:00")
		#expect(
			CronSchedule.describe("30 23 3 11 *", now: date(2026, 10, 20, 0, 0)) == "once on 4 Nov at 00:30")
		#expect(CronSchedule.describe("0 9 29 2 *", now: winter) == "once on 29 Feb 2028 at 10:00")
	}

	@Test("a date that never exists falls back to the raw expression")
	func oneTimeNeverExists() {
		#expect(CronSchedule.describe("0 9 31 11 *", now: winter) == "0 9 31 11 *")
	}

	@Test("a reminder date reads in Copenhagen time")
	func copenhagenDateTime() {
		#expect(CronSchedule.copenhagenDateTime(date(2026, 11, 3, 8, 0), now: date(2026, 10, 20, 0, 0)) == "3 Nov at 09:00")
		#expect(CronSchedule.copenhagenDateTime(date(2026, 7, 1, 8, 0), now: winter) == "1 Jul at 10:00")
		#expect(CronSchedule.copenhagenDateTime(date(2027, 11, 3, 8, 0), now: winter) == "3 Nov 2027 at 09:00")
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
