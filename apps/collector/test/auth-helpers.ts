import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { MailMessage, Mailer } from '../src/modules/mail/mailer.js';
import type { TestApp } from './helpers.js';

export const PASSWORD = 'correct horse battery staple';

export class FakeMailer implements Mailer {
  enabled = true;
  fail = false;
  sent: MailMessage[] = [];
  async send(m: MailMessage) {
    if (this.fail) throw new Error('SMTP server unreachable');
    this.sent.push(m);
  }
  /** The last one-time link sent to `to`. */
  linkTo(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m!.text.match(/https?:\/\/\S+/)![0];
  }
}

/** A browser: keeps the session cookie and the CSRF token like the dashboard does. */
export class Browser {
  cookie = '';
  csrf = '';
  constructor(
    private readonly t: TestApp,
    readonly ip = '203.0.113.10',
  ) {}

  async req(
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const res = await this.t.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    } as InjectOptions);
    const set = res.headers['set-cookie'];
    if (set) this.cookie = String(set).split(';')[0]!;
    if (this.cookie.endsWith('=')) this.cookie = '';
    const json = res.headers['content-type']?.toString().includes('json') ? res.json() : undefined;
    if (json && typeof json.csrfToken === 'string') this.csrf = json.csrfToken;
    return res;
  }

  async login(email: string, password = PASSWORD): Promise<LightMyRequestResponse> {
    return this.req('POST', '/v1/auth/login', { email, password });
  }

  async me(): Promise<LightMyRequestResponse> {
    return this.req('GET', '/v1/me');
  }
}

export const tokenFrom = (url: string) => url.split('/').pop()!;

export async function setUp(t: TestApp, email = 'ada@example.com') {
  const code = await t.ctx.accounts.issueSetupCode();
  const b = new Browser(t);
  const res = await b.req('POST', '/v1/auth/setup', {
    setupCode: code,
    email,
    name: 'Ada',
    password: PASSWORD,
  });
  expect(res.statusCode).toBe(200);
  return b;
}

export async function invite(admin: Browser, email: string) {
  const res = await admin.req('POST', '/v1/admin/users/invites', { email });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; url: string; emailed: boolean; emailError?: string };
}
