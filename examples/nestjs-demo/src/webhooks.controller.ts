import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';

const SECRET = process.env.WEBHOOK_SECRET ?? 'demo-webhook-secret';
const TOLERANCE_S = 24 * 3600;

/** Standard Webhooks verification: `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, any of several. */
function verify(id: string, ts: string, signatures: string, body: Buffer): boolean {
  const expected = createHmac('sha256', SECRET).update(`${id}.${ts}.`).update(body).digest();
  return signatures.split(' ').some((s) => {
    const [version, sig] = s.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/**
 * NotifyCo's webhooks (sent by the chaos provider, docs/demo.md). The SDK
 * records each delivery on its own: route template, our status, handling time
 * and the signed timestamp; it never reads the body or these headers' other
 * values. `PUT /__webhooks` on the chaos provider makes deliveries stop, arrive
 * late, fail verification (401) or ask this handler to be slow.
 */
@Controller('webhooks')
export class WebhooksController {
  @Post('notifyco')
  @HttpCode(200)
  async notifyco(
    @Req() req: RawBodyRequest<Request>,
    @Headers('webhook-id') id: string | undefined,
    @Headers('webhook-timestamp') ts: string | undefined,
    @Headers('webhook-signature') signature: string | undefined,
  ) {
    const body = req.rawBody ?? Buffer.from('');
    if (!id || !ts || !signature || !verify(id, ts, signature, body))
      throw new UnauthorizedException('invalid webhook signature');
    if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S)
      throw new UnauthorizedException('webhook timestamp outside tolerance');
    const event = req.body as { simulate?: string; delayMs?: number };
    // the demo's "slow handler": work done before acknowledging
    if (event?.simulate === 'slow')
      await new Promise((r) => setTimeout(r, Math.min(20_000, Number(event.delayMs) || 3000)));
    return { received: true };
  }
}
