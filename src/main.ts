import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // El logo de la empresa viaja como data-URL en la configuración: el body
  // default de 100kb no le alcanza a una imagen.
  app.use(json({ limit: '4mb' }));

  /*
   * Detrás del proxy del hosting, la request llega "desde" el proxy: sin esto,
   * el rate limit vería UNA sola IP para todos los visitantes y los bloquearía
   * en conjunto. `trust proxy` hace que `req.ip` sea la IP real del visitante
   * (X-Forwarded-For). CHECKLIST DEL DEPLOY: Node tiene que quedar escuchando
   * solo en localhost, con nginx como única puerta — si se puede llegar a Node
   * directo, ese encabezado se puede falsificar.
   */
  app.getHttpAdapter().getInstance().set('trust proxy', true);

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
