import { createChaosServer } from './server.js';
import { createWebhookSender } from './webhooks.js';

const port = Number(process.env.CHAOS_PORT ?? process.env.PORT ?? 4010);
// the fake provider also sends webhooks to the demo app when given a target
const webhooks = process.env.WEBHOOK_TARGET
  ? createWebhookSender({
      target: process.env.WEBHOOK_TARGET,
      secret: process.env.WEBHOOK_SECRET ?? 'demo-webhook-secret',
      ratePerMin: Number(process.env.WEBHOOK_RATE_PER_MIN ?? 30),
    })
  : undefined;
webhooks?.start();
const chaos = createChaosServer({
  ...(process.env.SINK_SECRET ? { sinkSecret: process.env.SINK_SECRET } : {}),
  ...(webhooks ? { webhooks } : {}),
});
chaos.server.listen(port, '0.0.0.0', () => {
  console.log(
    `chaos-provider listening on :${port} (admin: /__chaos, alert sink: /__alerts${webhooks ? `, webhooks to ${process.env.WEBHOOK_TARGET}: /__webhooks` : ''})`,
  );
});
const stop = () => {
  webhooks?.stop();
  void chaos.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
