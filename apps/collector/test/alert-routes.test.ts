import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmtpConfig } from '../src/config.js';
import { emailAdapter } from '../src/modules/alerts/channels.js';
import { testPayload } from '../src/modules/alerts/routes.js';
import { THEIRSIDE_ADMIN_TOKEN, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let hook: http.Server;
let hookUrl: string;
const received: string[] = [];

beforeAll(async () => {
  t = await startTestApp();
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push(b);
      if (req.url === '/slack-404') {
        // what Slack answers for a deleted webhook
        res.statusCode = 404;
        return res.end('no_service');
      }
      res.statusCode = req.url === '/fail' ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hook.close();
  await t.close();
});

const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${THEIRSIDE_ADMIN_TOKEN}` },
    ...(payload ? { payload } : {}),
  });

describe('alert channel admin API', () => {
  it('requires login', async () => {
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/admin/alert-channels' })).statusCode,
    ).toBe(401);
  });

  it.each([
    [
      { kind: 'webhook', name: 'x', config: { url: 'not a url', secret: '0123456789abcdef' } },
      /url/,
    ],
    [
      { kind: 'webhook', name: 'x', config: { url: 'https://example.test/h', secret: 'short' } },
      /secret/,
    ],
    [{ kind: 'slack', name: 'x', config: { webhookUrl: 'ftp://x' } }, /webhookUrl/],
    [{ kind: 'email', name: 'x', config: { to: ['not-an-email'] } }, /email/],
    [{ kind: 'pager', name: 'x', config: {} }, /invalid/],
  ])('validates %j', async (body, msg) => {
    const res = await admin('POST', '/v1/admin/alert-channels', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msg);
  });

  it('creates, lists with secrets redacted, updates and deletes', async () => {
    const created = await admin('POST', '/v1/admin/alert-channels', {
      kind: 'webhook',
      name: 'ops',
      config: { url: `${hookUrl}/ok`, secret: 'super-secret-value-123' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().config.secret).toBe('••••••');
    const id = created.json().id;

    const list = await admin('GET', '/v1/admin/alert-channels');
    expect(JSON.stringify(list.json())).not.toContain('super-secret-value-123');

    // sending the redacted placeholder back keeps the stored secret
    const patched = await admin('PATCH', `/v1/admin/alert-channels/${id}`, {
      name: 'ops renamed',
      config: { url: `${hookUrl}/ok`, secret: '••••••' },
    });
    expect(patched.statusCode).toBe(200);
    const stored = await t.db.storage.config.getAlertChannel(
      { orgId: t.orgId, projectId: t.projectId },
      id,
    );
    expect(stored!.config.secret).toBe('super-secret-value-123');
    expect(stored!.name).toBe('ops renamed');

    expect((await admin('DELETE', `/v1/admin/alert-channels/${id}`)).statusCode).toBe(204);
    expect((await admin('DELETE', `/v1/admin/alert-channels/${id}`)).statusCode).toBe(404);
  });

  it('sends a test alert and reports the result', async () => {
    const ok = (
      await admin('POST', '/v1/admin/alert-channels', {
        kind: 'webhook',
        name: 'good',
        config: { url: `${hookUrl}/ok`, secret: '0123456789abcdef' },
      })
    ).json();
    const bad = (
      await admin('POST', '/v1/admin/alert-channels', {
        kind: 'webhook',
        name: 'bad',
        config: { url: `${hookUrl}/fail`, secret: '0123456789abcdef' },
      })
    ).json();
    const r1 = await admin('POST', `/v1/admin/alert-channels/${ok.id}/test`);
    expect(r1.json()).toMatchObject({ status: 'sent', error: null });
    expect(JSON.parse(received.at(-1)!)).toMatchObject({
      event: 'test',
      provider: 'Example Provider',
      url: null, // THEIRSIDE_PUBLIC_URL unset in tests: no localhost link
    });
    const r2 = await admin('POST', `/v1/admin/alert-channels/${bad.id}/test`);
    expect(r2.json()).toMatchObject({
      status: 'failed',
      error: `HTTP 500 from ${new URL(hookUrl).host}`,
    });

    const deliveries = (await admin('GET', '/v1/admin/deliveries')).json();
    expect(deliveries.map((d: { event: string }) => d.event)).toEqual(
      expect.arrayContaining(['test']),
    );
    expect(deliveries[0]).not.toHaveProperty('payload');
  });

  it.each([
    [
      'Slack 4xx with its reason',
      () => `${hookUrl}/slack-404`,
      /^HTTP 404 from 127\.0\.0\.1:\d+: no_service$/,
    ],
    [
      'connection refused',
      async () => {
        const s = net.createServer();
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
        const port = (s.address() as AddressInfo).port;
        await new Promise<void>((r) => s.close(() => r()));
        return `http://127.0.0.1:${port}/hook`;
      },
      /^connection failed \(ECONNREFUSED\)/,
    ],
  ])('shows the exact error for a failed test alert: %s', async (_n, url, expected) => {
    const ch = (
      await admin('POST', '/v1/admin/alert-channels', {
        kind: 'slack',
        name: 'slack',
        config: { webhookUrl: await url() },
      })
    ).json();
    const res = (await admin('POST', `/v1/admin/alert-channels/${ch.id}/test`)).json();
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(expected);
  });

  it('renaming a disabled channel keeps it disabled', async () => {
    const ch = (
      await admin('POST', '/v1/admin/alert-channels', {
        kind: 'webhook',
        name: 'paused',
        config: { url: `${hookUrl}/ok`, secret: '0123456789abcdef' },
        enabled: false,
      })
    ).json();
    const res = await admin('PATCH', `/v1/admin/alert-channels/${ch.id}`, {
      name: 'paused, renamed',
    });
    expect(res.json()).toMatchObject({ name: 'paused, renamed', enabled: false });
  });

  it('only owners and admins can change channels', async () => {
    await t.db.pool.query(`UPDATE memberships SET role = 'viewer'`);
    const res = await admin('POST', '/v1/admin/alert-channels', {
      kind: 'webhook',
      name: 'x',
      config: { url: `${hookUrl}/ok`, secret: '0123456789abcdef' },
    });
    expect(res.statusCode).toBe(403);
    await t.db.pool.query(`UPDATE memberships SET role = 'owner'`);
  });
});

/** Just enough SMTP to accept messages; `rejectAuth` advertises AUTH and refuses it. */
async function smtpSink(opts: { rejectAuth?: boolean } = {}) {
  const messages: string[] = [];
  const server = net.createServer((sock) => {
    let data = false;
    let buf = '';
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            sock.write('250 queued\r\n');
          } else messages[messages.length - 1] += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO')
          sock.write(
            opts.rejectAuth ? '250-sink\r\n250 AUTH PLAIN LOGIN\r\n' : '250-sink\r\n250 OK\r\n',
          );
        else if (cmd === 'AUTH') sock.write('535 5.7.8 Username and Password not accepted\r\n');
        else if (cmd === 'DATA') {
          data = true;
          messages.push('');
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { messages, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

const smtp = (over: Partial<SmtpConfig>): SmtpConfig => ({
  url: undefined,
  host: undefined,
  port: 587,
  secure: false,
  requireTls: false,
  user: undefined,
  pass: undefined,
  from: 'alerts@example.test',
  ...over,
});
const channel = {
  id: 'c',
  orgId: 'o',
  projectId: 'p',
  kind: 'email' as const,
  name: 'mail',
  enabled: true,
  config: { to: ['oncall@example.test'] },
};

describe('email channel', () => {
  it('sends over SMTP', async () => {
    const sink = await smtpSink();
    const adapter = emailAdapter(smtp({ host: '127.0.0.1', port: sink.port }));
    await adapter.send(
      {
        id: 'c',
        orgId: 'o',
        projectId: 'p',
        kind: 'email',
        name: 'mail',
        enabled: true,
        config: { to: ['oncall@example.test'] },
      },
      testPayload('mail'),
      { deliveryId: 'd' },
    );
    expect(sink.messages).toHaveLength(1);
    // unfold RFC 5322 header continuation lines
    const msg = sink.messages[0]!.replace(/\n[ \t]+/g, ' ');
    expect(msg).toContain(
      'Subject: [Theirside] Test alert: Example Provider POST /v1/example/:id failing 38%',
    );
    expect(msg).toContain('oncall@example.test');
    // multipart: plain text and HTML
    expect(msg).toMatch(/Content-Type: multipart\/alternative/i);
    expect(msg).toMatch(/Content-Type: text\/plain/i);
    expect(msg).toMatch(/Content-Type: text\/html/i);
    sink.close();
  });

  it('accepts THEIRSIDE_SMTP_URL', async () => {
    const sink = await smtpSink();
    await emailAdapter(smtp({ url: `smtp://127.0.0.1:${sink.port}` })).send(
      channel,
      testPayload('mail'),
      { deliveryId: 'd' },
    );
    expect(sink.messages).toHaveLength(1);
    sink.close();
  });

  it.each([
    [
      'authentication failure',
      { rejectAuth: true },
      { user: 'u', pass: 'p', requireTls: false },
      /^SMTP authentication failed: 535 5\.7\.8 Username and Password not accepted/,
    ],
    ['TLS required but not offered', {}, { requireTls: true }, /TLS|STARTTLS/],
  ])('reports %s clearly', async (_n, sinkOpts, cfg, expected) => {
    const sink = await smtpSink(sinkOpts);
    await expect(
      emailAdapter(smtp({ host: '127.0.0.1', port: sink.port, ...cfg })).send(
        channel,
        testPayload('mail'),
        { deliveryId: 'd' },
      ),
    ).rejects.toThrow(expected);
    sink.close();
  });

  it('fails clearly without SMTP configuration', async () => {
    await expect(
      emailAdapter(undefined).send(
        {
          id: 'c',
          orgId: 'o',
          projectId: 'p',
          kind: 'email',
          name: 'm',
          enabled: true,
          config: { to: ['a@b.c'] },
        },
        testPayload('m'),
        { deliveryId: 'd' },
      ),
    ).rejects.toThrow(/SMTP is not configured/);
  });
});
