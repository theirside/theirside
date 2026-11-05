import { BadGatewayException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { getStats } from '@theirside/sdk';
import { ClsService } from 'nestjs-cls';
import {
  AcmeCardsClient,
  BankCoClient,
  GeoApiClient,
  InternalClients,
  KycoClient,
  NotifyCoClient,
  SaasCoClient,
} from './providers';
import { xrayStats } from './xray';

const id = (p: string) =>
  `${p}_${Math.floor(Math.random() * 10)}${Math.random().toString(36).slice(2, 10)}`;

/** A tiny "payments backend": each route fans out to one or more providers. */
@Controller()
export class DemoController {
  constructor(
    private readonly cards: AcmeCardsClient,
    private readonly kyc: KycoClient,
    private readonly bank: BankCoClient,
    private readonly notify: NotifyCoClient,
    private readonly saas: SaasCoClient,
    private readonly geo: GeoApiClient,
    private readonly internal: InternalClients,
    private readonly cls: ClsService,
  ) {}

  private async upstream<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BadGatewayException(`${what} failed: ${(err as Error).message}`);
    }
  }

  @Post('cards/:id/activate')
  async activate(@Param('id') cardId: string) {
    await this.upstream('Acme Cards activate', () =>
      Math.random() < 0.1 ? this.cards.sandboxActivate(cardId) : this.cards.activate(cardId),
    );
    void this.notify.send('+10000000000', 'card_activated').catch(() => {});
    // excluded automatically: internal service and telemetry
    void this.internal.ledgerEntry(cardId).catch(() => {});
    void this.internal.telemetry().catch(() => {});
    return { ok: true, cardId, requestId: this.cls.getId() };
  }

  @Get('cards/:id')
  async card(@Param('id') cardId: string) {
    const res = await this.upstream('Acme Cards get', () => this.cards.get(cardId));
    void this.cards.document(cardId).catch(() => {});
    return { ok: true, card: res.data };
  }

  @Post('onboarding')
  async onboarding(@Body() body: { applicantId?: string }) {
    const applicant = body?.applicantId ?? id('app');
    await this.upstream('KYCo check', () => this.kyc.check(applicant));
    await this.upstream('Acme Cards create', () => this.cards.create(applicant));
    await this.upstream('NotifyCo send', () =>
      this.notify.send('applicant@example.test', 'welcome'),
    );
    void this.saas.syncWorkspace(1 + Math.floor(Math.random() * 200)).catch(() => {});
    void this.geo.lookup('EC1A 1BB').catch(() => {});
    return { ok: true, applicant };
  }

  @Post('payouts')
  async payout(@Body() body: { accountId?: string; amount?: number }) {
    const account = body?.accountId ?? id('acc');
    await this.upstream('BankCo balance', () => this.bank.balance(account));
    await this.upstream('BankCo transfer', () => this.bank.transfer(account, body?.amount ?? 100));
    return { ok: true, account };
  }

  /** Proof of coexistence: SDK and X-Ray both see the calls. */
  @Get('debug/instrumentation')
  debug() {
    return { sdk: getStats() ?? null, xray: xrayStats };
  }

  @Get('healthz')
  health() {
    return { ok: true };
  }
}
