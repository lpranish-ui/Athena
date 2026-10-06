// Local review reminders — a daily 8pm nudge scheduled on the device
// (expo-notifications). Native only; web hides the toggle.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const PREF_KEY = 'athena.reminders.reviews';
const CHANNEL_ID = 'reviews';
const HOUR = 20;
const MINUTE = 0;

export const remindersSupported = Platform.OS !== 'web';

async function ensurePermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

/** Whether the daily reminder preference is on. */
export async function getReminderEnabled(): Promise<boolean> {
  if (!remindersSupported) return false;
  return (await AsyncStorage.getItem(PREF_KEY)) === 'on';
}

/** Turns the reminder on (asking permission) or off; returns the final state. */
export async function setReminderEnabled(enabled: boolean): Promise<boolean> {
  if (!remindersSupported) return false;
  if (!enabled) {
    await AsyncStorage.setItem(PREF_KEY, 'off');
    await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
    return false;
  }
  if (!(await ensurePermission())) return false;
  await AsyncStorage.setItem(PREF_KEY, 'on');
  await scheduleDailyReviewReminder();
  return true;
}

/** Cancels and re-creates the daily reminder; no-op when disabled/unsupported. */
export async function scheduleDailyReviewReminder(): Promise<void> {
  if (!remindersSupported) return;
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  if ((await AsyncStorage.getItem(PREF_KEY)) !== 'on') return;
  if (!(await ensurePermission())) return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Review reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Time to review',
      body: 'Your flashcards are waiting — a few minutes now keeps memory strong.',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: HOUR,
      minute: MINUTE,
      channelId: CHANNEL_ID,
    },
  });
}
