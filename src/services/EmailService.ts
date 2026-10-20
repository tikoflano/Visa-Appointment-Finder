import nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

function parseAddressList(value?: string): string | string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list;
}

export class EmailService {
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      auth: {
        user: process.env.GMAIL_APP_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }

  async sendMail(
    to: string,
    subject: string,
    html: string,
    bcc?: string,
  ): Promise<void> {
    await this.transporter.sendMail({
      from: `Visa Appointment Scheduler<${process.env.GMAIL_APP_USER}>`,
      to: parseAddressList(to),
      bcc: parseAddressList(bcc),
      subject,
      html,
    });
  }
}

