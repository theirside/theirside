import { describe, expect, it, vi } from 'vitest';
import {
  EndpointTemplater,
  OVERFLOW_TEMPLATE,
  autoTemplate,
  compileRoute,
  isIdSegment,
  pathOnly,
} from '../src/templating.js';

describe('autoTemplate', () => {
  const cases: Array<[string, string]> = [
    // integers and query strings
    ['/v1/accounts/12345', '/v1/accounts/:id'],
    ['/v1/accounts/12345?expand=owner&token=secret', '/v1/accounts/:id'],
    ['/v1/accounts/12345#frag', '/v1/accounts/:id'],
    ['/', '/'],
    ['', '/'],
    ['/v1/accounts/', '/v1/accounts'],
    ['?q=1', '/'],
    // Stripe-style prefixed ids
    ['/v1/customers/cus_NffrFeUfNV2Hib', '/v1/customers/:id'],
    ['/v1/customers/cus_123/sources', '/v1/customers/:id/sources'],
    ['/v1/payment_intents/pi_3MtwBwLkdIwHu7ix28a3tqPa/confirm', '/v1/payment_intents/:id/confirm'],
    ['/v2/cards/card_8f2KdL3x/activate', '/v2/cards/:id/activate'],
    ['/v1/charges/ch_3LmzzQ2eZvKYlo2C0r4mH7xY/refunds', '/v1/charges/:id/refunds'],
    // UUID / ULID / ObjectId / hex
    ['/v1/kyc/checks/9b2f6c1e-3d4a-4f7e-9a1b-0c2d3e4f5a6b', '/v1/kyc/checks/:id'],
    ['/v1/kyc/checks/9B2F6C1E-3D4A-4F7E-9A1B-0C2D3E4F5A6B/result', '/v1/kyc/checks/:id/result'],
    ['/v1/events/01ARZ3NDEKTSV4RRFFQ69G5FAV', '/v1/events/:id'],
    ['/api/users/507f1f77bcf86cd799439011', '/api/users/:id'],
    ['/blobs/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', '/blobs/:id'],
    // card numbers (PANs) must never survive, in any shape
    ['/v1/cards/4111111111111111', '/v1/cards/:id'],
    ['/v1/cards/4111-1111-1111-1111/balance', '/v1/cards/:id/balance'],
    ['/v1/cards/4111%201111%201111%201111', '/v1/cards/:id'],
    ['/v1/lookup/pan4111111111111111', '/v1/lookup/:id'],
    ['/v1/lookup/411111111111', '/v1/lookup/:id'],
    ['/v1/lookup/5555555555554444333', '/v1/lookup/:id'],
    // emails, raw and encoded
    ['/v1/users/jane.doe@example.com/limits', '/v1/users/:id/limits'],
    ['/v1/users/jane.doe%40example.com', '/v1/users/:id'],
    // mixed letters and digits
    ['/v1/orders/ord8fk2l9', '/v1/orders/:id'],
    ['/v1/orders/abc123', '/v1/orders/:id'],
    ['/v1/transfers/TRX-2024-000184', '/v1/transfers/:id'],
    ['/v1/statements/2024-01-31', '/v1/statements/:id'],
    // long tokens
    ['/v1/sessions/AbCdEfGhIjKlMnOpQrSt', '/v1/sessions/:id'],
    ['/v1/sessions/dGhpcyBpcyBhIHRva2Vu%2B%2Fx%3D', '/v1/sessions/:id'],
    ['/v1/links/' + 'x'.repeat(80), '/v1/links/:id'],
    // things that must stay literal
    ['/v2/cards/:id/activate', '/v2/cards/:id/activate'],
    ['/v1/payment_methods', '/v1/payment_methods'],
    ['/api/v2/accounts/balance', '/api/v2/accounts/balance'],
    ['/v1.2/reports', '/v1.2/reports'],
    ['/oauth2/token', '/oauth2/token'],
    ['/v1/getAccountBalances', '/v1/getAccountBalances'],
    ['/s3/buckets', '/s3/buckets'],
    ['/api-v2/ping', '/api-v2/ping'],
    ['/v1/kyc/checks', '/v1/kyc/checks'],
    ['/.well-known/openid-configuration', '/.well-known/openid-configuration'],
    // proxy-style absolute URLs
    ['https://api.acme.com/v1/cards/123?x=1', '/v1/cards/:id'],
    ['http://api.acme.com', '/'],
  ];

  it.each(cases)('%s -> %s', (input, expected) => {
    expect(autoTemplate(input)).toBe(expected);
  });

  it('never lets a 12-19 digit run through', () => {
    for (let len = 12; len <= 19; len++) {
      const digits = '4'.repeat(len);
      for (const shape of [digits, `x${digits}`, `${digits}y`, `ref_${digits}`, `a-${digits}-b`]) {
        expect(autoTemplate(`/v1/p/${shape}`)).toBe('/v1/p/:id');
      }
    }
  });
});

describe('isIdSegment', () => {
  it.each([
    ['v1', false],
    ['v20', false],
    ['cards', false],
    ['md5', false],
    ['ipv4', false],
    ['x509', true],
    ['42', true],
    ['', false],
  ])('%s -> %s', (seg, expected) => {
    expect(isIdSegment(seg)).toBe(expected);
  });
});

describe('pathOnly', () => {
  it.each([
    ['/a/b?c=d', '/a/b'],
    ['a/b', '/a/b'],
    ['https://h.example/a?x', '/a'],
    ['/a#b?c', '/a'],
  ])('%s -> %s', (input, expected) => {
    expect(pathOnly(input)).toBe(expected);
  });
});

describe('explicit routes', () => {
  const cases: Array<[string[], string, string]> = [
    [['/v2/cards/:cardId/activate'], '/v2/cards/abc/activate', '/v2/cards/:cardId/activate'],
    [['/v2/cards/:cardId/activate'], '/v2/cards/abc/activate?x=1', '/v2/cards/:cardId/activate'],
    [['/v2/cards/:cardId/activate'], '/v2/cards/c4rd9x2/freeze', '/v2/cards/:id/freeze'],
    [['/v2/cards/:cardId/activate'], '/v2/cards/activate', '/v2/cards/activate'],
    // explicit routes win over auto collapse, even for literal-looking segments
    [['/v1/users/:username'], '/v1/users/jane', '/v1/users/:username'],
    [['/files/*'], '/files/a/b/c.txt', '/files/*'],
    [['/files/:path*'], '/files', '/files/:path*'],
    [['/a/:x', '/a/:x/b'], '/a/1/b', '/a/:x/b'],
    [['/a/b', '/a/:x'], '/a/b', '/a/b'],
  ];
  it.each(cases)('%j matches %s as %s', (routes, path, expected) => {
    const t = new EndpointTemplater();
    expect(t.template('h', path, routes.map(compileRoute))).toBe(expected);
  });

  it('strips query from route definitions', () => {
    expect(compileRoute('/a/:id?x=1').template).toBe('/a/:id');
  });
});

describe('cardinality guard', () => {
  it('caps auto templates per host and warns once', () => {
    const onOverflow = vi.fn();
    const t = new EndpointTemplater({ maxTemplatesPerHost: 200, onOverflow });
    for (let i = 0; i < 200; i++)
      expect(
        t.template('h1', `/word${'x'.repeat(i % 50)}/${'y'.repeat(Math.floor(i / 50))}z`),
      ).not.toBe(OVERFLOW_TEMPLATE);
    expect(t.template('h1', '/brand/new')).toBe(OVERFLOW_TEMPLATE);
    expect(t.template('h1', '/another/new')).toBe(OVERFLOW_TEMPLATE);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith('h1');
    // existing templates keep working, other hosts unaffected
    expect(t.template('h1', '/wordx/z')).toBe('/wordx/z');
    expect(t.template('h2', '/brand/new')).toBe('/brand/new');
  });

  it('does not count explicit routes toward the cap', () => {
    const t = new EndpointTemplater({ maxTemplatesPerHost: 1 });
    const routes = [compileRoute('/r/:a')];
    expect(t.template('h', '/r/1', routes)).toBe('/r/:a');
    expect(t.template('h', '/auto')).toBe('/auto');
    expect(t.template('h', '/auto2')).toBe(OVERFLOW_TEMPLATE);
  });

  it('keeps the lookup cache bounded', () => {
    const t = new EndpointTemplater({ cacheSize: 10 });
    for (let i = 0; i < 1000; i++) t.template('h', `/a/${i}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((t as any).cache.size).toBeLessThanOrEqual(10);
  });
});
