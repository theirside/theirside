import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../../config.js';

export const SMTP_TIMEOUT_MS = 10_000;

/** A nodemailer transport for THEIRSIDE_SMTP_*, or null when SMTP is not configured. */
export function createMailTransport(smtp: SmtpConfig | undefined) {
  if (!smtp) return null;
  const timeouts = {
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
  return smtp.url
    ? nodemailer.createTransport({ url: smtp.url, requireTLS: smtp.requireTls, ...timeouts })
    : nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        // true = implicit TLS (port 465); false = plain connection upgraded with STARTTLS
        secure: smtp.secure,
        requireTLS: smtp.requireTls,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
        ...timeouts,
      });
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Account emails (invites, password resets). `enabled` is false without SMTP. */
export interface Mailer {
  readonly enabled: boolean;
  send(m: MailMessage): Promise<void>;
}

export function smtpMailer(smtp: SmtpConfig | undefined): Mailer {
  const transport = createMailTransport(smtp);
  return {
    enabled: !!transport,
    async send(m) {
      if (!transport || !smtp) throw new Error('SMTP is not configured');
      await transport.sendMail({ from: smtp.from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
