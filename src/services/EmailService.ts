import nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

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

  async sendMail(to: string, subject: string, html: string): Promise<void> {
    await this.transporter.sendMail({
      from: `Visa Appointment Scheduler<${process.env.GMAIL_APP_USER}>`,
      to,
      subject,
      html,
    });
  }
}

