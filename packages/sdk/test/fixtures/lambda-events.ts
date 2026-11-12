/**
 * AWS Lambda invocation events, shaped like the samples in AWS's documentation
 * (API Gateway REST payload 1.0, HTTP API payload 2.0, ALB target, function
 * URL, and non-HTTP sources). IDs and hosts are fake. Each HTTP event carries a
 * body and a query string with secrets that must never leave the SDK.
 */

export const SECRET_BODY =
  '{"id":"evt_1","data":{"card":"4242424242424242","email":"ivan@example.com"}}';
export const SECRET_QUERY = 'sekrit-query-token';

type Headers = Record<string, string>;

/** API Gateway REST API, Lambda proxy integration (payload 1.0). Header case as the sender wrote it. */
export function restEvent(path: string, headers: Headers, opts: { stage?: string } = {}) {
  const stage = opts.stage ?? 'prod';
  const all: Headers = {
    Accept: '*/*; q=0.5, application/xml',
    'Content-Type': 'application/json; charset=utf-8',
    Host: 'abc123def4.execute-api.eu-west-1.amazonaws.com',
    'User-Agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
    'X-Amzn-Trace-Id': 'Root=1-6730d6a1-0a1b2c3d4e5f60718293a4b5',
    'X-Forwarded-For': '54.187.174.169',
    'X-Forwarded-Port': '443',
    'X-Forwarded-Proto': 'https',
    ...headers,
  };
  return {
    resource: path,
    path,
    httpMethod: 'POST',
    headers: all,
    multiValueHeaders: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, [v]])),
    queryStringParameters: { token: SECRET_QUERY },
    multiValueQueryStringParameters: { token: [SECRET_QUERY] },
    pathParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123def4',
      domainName: 'abc123def4.execute-api.eu-west-1.amazonaws.com',
      domainPrefix: 'abc123def4',
      extendedRequestId: 'BQGojGKXjoEFtFg=',
      httpMethod: 'POST',
      identity: {
        accessKey: null,
        accountId: null,
        caller: null,
        sourceIp: '54.187.174.169',
        user: null,
        userAgent: 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
        userArn: null,
      },
      path: `/${stage}${path}`,
      protocol: 'HTTP/1.1',
      requestId: 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef',
      requestTime: '10/Nov/2026:12:00:00 +0000',
      requestTimeEpoch: 1794312000000,
      resourceId: 'roq9wj',
      resourcePath: path,
      stage,
    },
    body: SECRET_BODY,
    isBase64Encoded: false,
  };
}

/** API Gateway HTTP API (payload 2.0). Headers lower-case; a named stage prefixes rawPath. */
export function httpApiEvent(path: string, headers: Headers, opts: { stage?: string } = {}) {
  const stage = opts.stage ?? '$default';
  const rawPath = stage === '$default' ? path : `/${stage}${path}`;
  return {
    version: '2.0',
    routeKey: `POST ${path}`,
    rawPath,
    rawQueryString: `token=${SECRET_QUERY}`,
    cookies: ['session=sekrit-cookie'],
    headers: {
      accept: '*/*',
      'content-length': String(SECRET_BODY.length),
      'content-type': 'application/json',
      host: 'r3pmxmplak.execute-api.eu-west-1.amazonaws.com',
      'user-agent': 'GitHub-Hookshot/abc1234',
      'x-amzn-trace-id': 'Root=1-6730d6a1-0a1b2c3d4e5f60718293a4b5',
      'x-forwarded-for': '140.82.115.10',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https',
      ...headers,
    },
    queryStringParameters: { token: SECRET_QUERY },
    requestContext: {
      accountId: '123456789012',
      apiId: 'r3pmxmplak',
      domainName: 'r3pmxmplak.execute-api.eu-west-1.amazonaws.com',
      domainPrefix: 'r3pmxmplak',
      http: {
        method: 'POST',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '140.82.115.10',
        userAgent: 'GitHub-Hookshot/abc1234',
      },
      requestId: 'JKJaXmPLvHcESHA=',
      routeKey: `POST ${path}`,
      stage,
      time: '10/Nov/2026:12:00:00 +0000',
      timeEpoch: 1794312000000,
    },
    body: SECRET_BODY,
    isBase64Encoded: false,
  };
}

/** Lambda function URL (payload 2.0, routeKey $default, a lambda-url domain). */
export function functionUrlEvent(path: string, headers: Headers) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: `token=${SECRET_QUERY}`,
    headers: {
      'content-type': 'application/json',
      host: 'a1b2c3d4e5f6g7h8i9j0.lambda-url.eu-west-1.on.aws',
      'user-agent': 'Shopify-Captain-Hook',
      'x-amzn-tls-version': 'TLSv1.3',
      'x-forwarded-for': '34.68.1.1',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https',
      ...headers,
    },
    queryStringParameters: { token: SECRET_QUERY },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'a1b2c3d4e5f6g7h8i9j0',
      domainName: 'a1b2c3d4e5f6g7h8i9j0.lambda-url.eu-west-1.on.aws',
      domainPrefix: 'a1b2c3d4e5f6g7h8i9j0',
      http: {
        method: 'POST',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '34.68.1.1',
        userAgent: 'Shopify-Captain-Hook',
      },
      requestId: 'b0c5e2f1-1234-4cde-9abc-0123456789ab',
      routeKey: '$default',
      stage: '$default',
      time: '10/Nov/2026:12:00:00 +0000',
      timeEpoch: 1794312000000,
    },
    body: Buffer.from(SECRET_BODY).toString('base64'),
    isBase64Encoded: true,
  };
}

/** ALB target group (lower-case headers; `multi: true`: multi-value headers turned on). */
export function albEvent(path: string, headers: Headers, opts: { multi?: boolean } = {}) {
  const all: Headers = {
    accept: '*/*',
    'content-type': 'application/json',
    host: 'webhooks-1234567890.eu-west-1.elb.amazonaws.com',
    'user-agent': 'Twilio-SendGrid/1.0',
    'x-amzn-trace-id': 'Root=1-6730d6a1-0a1b2c3d4e5f60718293a4b5',
    'x-forwarded-for': '167.89.1.1',
    'x-forwarded-port': '443',
    'x-forwarded-proto': 'https',
    ...headers,
  };
  const base = {
    requestContext: {
      elb: {
        targetGroupArn:
          'arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/webhooks/6d0ecf831eec9f09',
      },
    },
    httpMethod: 'POST',
    path,
    body: SECRET_BODY,
    isBase64Encoded: false,
  };
  return opts.multi
    ? {
        ...base,
        multiValueQueryStringParameters: { token: [SECRET_QUERY] },
        multiValueHeaders: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, [v]])),
      }
    : { ...base, queryStringParameters: { token: SECRET_QUERY }, headers: all };
}

/** Event sources that aren't HTTP requests: never deliveries. */
export const NON_HTTP_EVENTS: Record<string, unknown> = {
  sqs: {
    Records: [
      {
        messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
        receiptHandle: 'AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...',
        body: SECRET_BODY,
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1794312000000',
          SenderId: 'AIDAIENQZJOLO23YVJ4VO',
          ApproximateFirstReceiveTimestamp: '1794312000001',
        },
        messageAttributes: {},
        md5OfBody: 'e4e68fb7bd0e697a0ae8f1bb342846b3',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:my-queue',
        awsRegion: 'eu-west-1',
      },
    ],
  },
  eventbridge: {
    version: '0',
    id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
    'detail-type': 'EC2 Instance State-change Notification',
    source: 'aws.ec2',
    account: '123456789012',
    time: '2026-11-10T12:00:00Z',
    region: 'eu-west-1',
    resources: ['arn:aws:ec2:eu-west-1:123456789012:instance/i-1234567890abcdef0'],
    detail: { 'instance-id': 'i-1234567890abcdef0', state: 'terminated' },
  },
  s3: {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'eu-west-1',
        eventTime: '2026-11-10T12:00:00.000Z',
        eventName: 'ObjectCreated:Put',
        requestParameters: { sourceIPAddress: '127.0.0.1' },
        s3: {
          s3SchemaVersion: '1.0',
          bucket: { name: 'example-bucket', arn: 'arn:aws:s3:::example-bucket' },
          object: { key: 'webhooks/stripe', size: 1024 },
        },
      },
    ],
  },
  schedule: {
    version: '0',
    id: '53dc4d37-cffa-4f76-80c9-8b7d4a4d2eaa',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: '2026-11-10T12:00:00Z',
    region: 'eu-west-1',
    resources: ['arn:aws:events:eu-west-1:123456789012:rule/my-schedule'],
    detail: {},
  },
  // a WebSocket API message has a requestContext but no HTTP method or path
  websocket: {
    requestContext: {
      routeKey: '$default',
      eventType: 'MESSAGE',
      connectionId: 'L0SM9cOFvHcCIhw=',
      stage: 'prod',
    },
    body: SECRET_BODY,
    isBase64Encoded: false,
  },
  empty: {},
  string: 'not an event',
};
