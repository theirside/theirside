import { createChaosServer } from './server.js';

const port = Number(process.env.CHAOS_PORT ?? process.env.PORT ?? 4010);
const chaos = createChaosServer({
  ...(process.env.SINK_SECRET ? { sinkSecret: process.env.SINK_SECRET } : {}),
});
chaos.server.listen(port, '0.0.0.0', () => {
  console.log(`chaos-provider listening on :${port} (admin: /__chaos, alert sink: /__alerts)`);
});
const stop = () => void chaos.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
