import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import AWSXRay from 'aws-xray-sdk-core';

/** Counts what the X-Ray SDK emits, standing in for the X-Ray daemon. */
export const xrayStats = { segments: 0, subsegments: 0 };

export function startXRay(): void {
  if (process.env.XRAY_ENABLED === '0') return;
  const port = Number(process.env.XRAY_STUB_PORT ?? 2000);
  const stub = dgram.createSocket('udp4');
  stub.on('message', (msg) => {
    // each datagram: '{"format":"json","version":1}\n<segment json>'
    const body = msg.toString('utf8').split('\n')[1];
    if (!body) return;
    try {
      const seg = JSON.parse(body) as { subsegments?: unknown[] };
      xrayStats.segments++;
      xrayStats.subsegments += seg.subsegments?.length ?? 0;
    } catch {
      // ignore
    }
  });
  stub.bind(port, '127.0.0.1');
  stub.unref();

  AWSXRay.setDaemonAddress(`127.0.0.1:${port}`);
  AWSXRay.setContextMissingStrategy('IGNORE_ERROR');
  AWSXRay.setLogger({ error() {}, warn() {}, info() {}, debug() {} });
  AWSXRay.captureHTTPsGlobal(http, true);
  AWSXRay.captureHTTPsGlobal(https, true);
}

/** Express-style middleware: one X-Ray segment per incoming request. */
export function xrayMiddleware(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void,
): void {
  if (process.env.XRAY_ENABLED === '0') return next();
  const ns = AWSXRay.getNamespace();
  ns.bindEmitter(req);
  ns.bindEmitter(res);
  ns.run(() => {
    const segment = new AWSXRay.Segment('nestjs-demo');
    AWSXRay.setSegment(segment);
    res.on('finish', () => segment.close());
    next();
  });
}
