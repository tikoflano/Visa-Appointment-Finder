import { DatabaseService } from "../services/DatabaseService";
import { EmailService } from "../services/EmailService";
import { NotificationService } from "../services/NotificationService";
import { Store, ValidationError } from "./Store";

export async function sendHeartbeat(
  store: Store,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; lastHeartbeatAt: string | null }> {
  const settings = await store.getSettings();
  const configured =
    !!settings.emailAdminDestination &&
    !!settings.gmailUser &&
    settings.hasGmailAppPassword;

  if (options.force) {
    if (!settings.emailAdminDestination) {
      throw new ValidationError("Admin notification emails are required");
    }
    if (!settings.gmailUser || !settings.hasGmailAppPassword) {
      throw new ValidationError("Gmail credentials are not configured");
    }
  } else {
    if (!settings.heartbeatEnabled) {
      return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
    }
    if (!configured) {
      console.warn(
        "Heartbeat is enabled but Gmail or admin notification emails are not configured",
      );
      return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
    }
    if (settings.lastHeartbeatAt) {
      const elapsedMinutes = Math.floor(
        (Date.now() - +new Date(settings.lastHeartbeatAt)) / 60000,
      );
      if (elapsedMinutes < settings.heartbeatMinutes) {
        return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
      }
    }
  }

  const notify = new NotificationService(
    new DatabaseService(store.db),
    new EmailService({
      user: settings.gmailUser,
      pass: await store.getGmailAppPassword(),
    }),
  );
  const sent = await notify.sendHeartbeatNotification({
    force: !!options.force,
    destination: settings.emailAdminDestination,
    intervalMinutes: settings.heartbeatMinutes,
  });
  return { sent, lastHeartbeatAt: await store.getLastHeartbeatAt() };
}
