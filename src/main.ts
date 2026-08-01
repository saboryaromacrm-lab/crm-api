import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000,http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(config.get('PORT') ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`CRM API escuchando en http://localhost:${port}/api`);
}
bootstrap();
