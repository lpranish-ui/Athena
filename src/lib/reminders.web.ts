// Device notification reminders are available in the native app.
// Keep expo-notifications out of the browser bundle entirely; a runtime
// Platform check in the native implementation does not prevent Metro imports.
export const remindersSupported = false;

export async function getReminderEnabled(): Promise<boolean> {
  return false;
}

export async function setReminderEnabled(_enabled: boolean): Promise<boolean> {
  return false;
}

export async function scheduleDailyReviewReminder(): Promise<void> {
  // The web client cannot schedule native device reminders.
}
