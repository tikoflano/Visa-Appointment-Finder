import { EmailService } from "../services/EmailService";
import { NotificationService } from "../services/NotificationService";
import { isFailureRun, RunStatus, Store } from "./Store";
import { BotResult } from "../botResult";

export async function maybeSendFailureAlarm(
  store: Store,
  profileId: number,
  status: RunStatus,
  result: BotResult | null,
): Promise<void> {
  if (!isFailureRun({ status, result })) return;

  const settings = await store.getSettings();
  const threshold = settings.failureAlarmThreshold;
  if (!Number.isInteger(threshold) || threshold < 1) return;

  const { count, errors } = await store.countConsecutiveFailures(profileId);
  if (count !== threshold) return;

  if (
    !settings.emailAdminDestination ||
    !settings.gmailUser ||
    !settings.hasGmailAppPassword
  ) {
    console.warn(
      `Profile ${profileId} hit ${count} consecutive failures, but Gmail or admin notification emails are not configured`,
    );
    return;
  }

  const profile = await store.getProfile(profileId);
  if (!profile) return;

  const notify = new NotificationService(
    null,
    new EmailService({
      user: settings.gmailUser,
      pass: await store.getGmailAppPassword(),
    }),
  );
  await notify.sendFailureAlarm({
    destination: settings.emailAdminDestination,
    profileName: profile.name,
    visaEmail: profile.visaEmail,
    visaProcessId: profile.visaProcessId,
    threshold,
    errors: errors.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
      error: run.result?.error ?? null,
    })),
  });
}
