import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  /*
   * Cabeceras de seguridad. La API devuelve JSON y, en un endpoint, el binario
   * de una imagen de la tienda — no sirve HTML, así que el CSP de helmet no
   * tiene nada que proteger acá y sí puede molestar (la página la sirve nginx
   * con su propia configuración). Lo que sí importa de esta lista:
   *   - `noSniff`: sin él, un navegador puede decidir que una imagen subida es
   *     HTML y ejecutarla. Ya estaba puesto a mano en el módulo de facturas;
   *     ahora vale para toda la API.
   *   - `frameguard`: que nadie meta la API en un iframe.
   *   - se apaga el `X-Powered-By` de Express, que anuncia con qué está hecho.
   */
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

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
  /*
   * EN QUÉ INTERFAZ ESCUCHA, y por qué es una variable y no una constante.
   *
   * En el VPS tiene que ser `127.0.0.1`: nginx es la única puerta, y si se
   * puede llegar a Node directo (IP:3001) el `X-Forwarded-For` de arriba se
   * puede falsificar y encima se saltea el TLS.
   *
   * Pero NO puede estar hardcodeado, porque en la red del local la API la
   * consumen otras máquinas: la sync de coffit (la cafetería) y las cajas.
   * Con `127.0.0.1` fijo, eso dejaría de andar en desarrollo.
   *
   * Default `0.0.0.0` = lo de siempre; el `.env` del servidor lo baja a
   * localhost. Ver deploy/DEPLOY.md.
   */
  const host = (config.get<string>('HOST') ?? '0.0.0.0').trim();
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`CRM API escuchando en http://${host}:${port}/api`);
}
bootstrap();
