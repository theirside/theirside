/**
 * The app's own code the samples in docs/site call, so each block can stay short and
 * still type-check. Only names that stand for "your code" belong here; never anything
 * from the SDK.
 */

/** A provider client in your app (expected-outcomes.md). */
declare const consentClient: {
  check(userId: string): Promise<{ consented: boolean }>;
};
/** Your business logic (serverless.md, expected-outcomes.md). */
declare function chargeCard(event: unknown): Promise<{ statusCode: number; body: string }>;
declare function syncInvoices(): Promise<void>;
declare function handleWebhook(body: string | undefined): Promise<void>;
declare function verifySignature(event: unknown): boolean;
/** Your configuration loader (node-servers.md, serverless.md): SSM, Secrets Manager, Vault… */
declare function loadConfig(): Promise<{
  theirsideApiKey: string;
  theirsideCollectorUrl: string;
  environment: string;
}>;
