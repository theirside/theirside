// Must be the first import: instruments HTTP clients before anything else loads them.
import './instrumentation';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { xrayMiddleware } from './xray';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(xrayMiddleware);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`nestjs-demo listening on :${port}`);
}
void bootstrap();
