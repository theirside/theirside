import dns from 'node:dns';
import http from 'node:http';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { PROVIDER_URLS } from './instrumentation';

const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS ?? 5000);

/** Card issuing, via @nestjs/axios HttpService. */
@Injectable()
export class AcmeCardsClient {
  constructor(private readonly http: HttpService) {}
  activate(cardId: string) {
    return firstValueFrom(
      this.http.post(
        `${PROVIDER_URLS.acme}/v2/cards/${cardId}/activate`,
        {},
        { timeout: TIMEOUT_MS },
      ),
    );
  }
  get(cardId: string) {
    return firstValueFrom(
      this.http.get(`${PROVIDER_URLS.acme}/v2/cards/${cardId}`, { timeout: TIMEOUT_MS }),
    );
  }
  create(holderId: string) {
    return firstValueFrom(
      this.http.post(`${PROVIDER_URLS.acme}/v2/cards`, { holderId }, { timeout: TIMEOUT_MS }),
    );
  }
  /** Same provider, another host: grouped with api.acmecards.test by the collector. */
  document(cardId: string) {
    return firstValueFrom(
      this.http.get(`${PROVIDER_URLS.acmeFiles}/v1/files/${cardId}`, { timeout: TIMEOUT_MS }),
    );
  }
  /** And a third one (test-mode activations). */
  sandboxActivate(cardId: string) {
    return firstValueFrom(
      this.http.post(
        `${PROVIDER_URLS.acmeSandbox}/v2/cards/${cardId}/activate`,
        {},
        { timeout: TIMEOUT_MS },
      ),
    );
  }
}

/** Identity verification, via HttpService. */
@Injectable()
export class KycoClient {
  constructor(private readonly http: HttpService) {}
  check(applicantId: string) {
    return firstValueFrom(
      this.http.post(
        `${PROVIDER_URLS.kyc}/v1/kyc/checks`,
        { applicantId },
        { timeout: TIMEOUT_MS },
      ),
    );
  }
}

/** Banking-as-a-service, via HttpService. */
@Injectable()
export class BankCoClient {
  constructor(private readonly http: HttpService) {}
  transfer(accountId: string, amount: number) {
    return firstValueFrom(
      this.http.post(
        `${PROVIDER_URLS.bank}/v1/transfers`,
        { accountId, amount },
        { timeout: TIMEOUT_MS },
      ),
    );
  }
  balance(accountId: string) {
    return firstValueFrom(
      this.http.get(`${PROVIDER_URLS.bank}/v1/accounts/${accountId}/balance`, {
        timeout: TIMEOUT_MS,
      }),
    );
  }
}

/** Notifications, via global fetch (undici). */
@Injectable()
export class NotifyCoClient {
  async send(to: string, template: string) {
    const res = await fetch(`${PROVIDER_URLS.notify}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, template }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`NotifyCo ${res.status}`);
  }
}

/** Address checks, via fetch: a provider the demo history doesn't know yet. */
@Injectable()
export class GeoApiClient {
  async lookup(postcode: string) {
    const res = await fetch(
      `${PROVIDER_URLS.geo}/v1/geocode?postcode=${encodeURIComponent(postcode)}`,
      {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    await res.arrayBuffer();
  }
}

/** Resolves every *.saasco.test name to the chaos provider (Docker can't alias 200 names). */
const saascoLookup = ((hostname: string, options: unknown, cb: unknown) => {
  const done = (typeof options === 'function' ? options : cb) as (...a: unknown[]) => void;
  const opts = typeof options === 'object' && options ? (options as dns.LookupOptions) : {};
  dns.lookup(PROVIDER_URLS.saascoTarget, opts as dns.LookupAllOptions, done as never);
}) as typeof dns.lookup;

/** A SaaS with one subdomain per customer: the collector folds them into *.saasco.test. */
@Injectable()
export class SaasCoClient {
  syncWorkspace(tenant: number) {
    return new Promise<void>((resolve, reject) => {
      http
        .get(
          {
            hostname: `t${tenant}.${PROVIDER_URLS.saasco}`,
            port: PROVIDER_URLS.saascoPort,
            path: '/v1/workspace/sync',
            lookup: saascoLookup,
            timeout: TIMEOUT_MS,
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject)
        .on('timeout', function (this: http.ClientRequest) {
          this.destroy(new Error('timeout'));
        });
    });
  }
}

/** Calls the SDK must never record: the team's own service and its error tracker. */
@Injectable()
export class InternalClients {
  async ledgerEntry(cardId: string) {
    const res = await fetch(`${PROVIDER_URLS.ledger}/v1/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer();
  }
  async telemetry() {
    const res = await fetch(`${PROVIDER_URLS.telemetry}/api/4501/envelope/`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer();
  }
}
