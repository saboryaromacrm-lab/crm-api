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
   * A QUIÉN LE CREE EXPRESS CUANDO DICE DE DÓNDE VIENE LA REQUEST.
   *
   * Detrás de un proxy, la request llega "desde" el proxy: sin esto, el rate
   * limit vería UNA sola IP para todos los visitantes y los bloquearía en
   * conjunto. `trust proxy` hace que `req.ip` sea la IP real del visitante
   * (X-Forwarded-For), y de ahí salen tanto el cupo de la tienda como el freno
   * de intentos del login.
   *
   * Lo que NO puede ser es `true`: ahí Express se cree TODA la cadena de
   * X-Forwarded-For y toma el primer valor, que lo escribe el cliente. Un
   * atacante manda `X-Forwarded-For: 10.0.0.1` y su `req.ip` pasa a ser eso: se
   * hace pasar por infraestructura interna (que el cupo exime) y de paso diluye
   * el freno del login cambiando de "IP" en cada intento.
   *
   * ES UNA VARIABLE PORQUE HAY DOS FORMAS DE PUBLICAR ESTO, y la respuesta
   * correcta es distinta en cada una:
   *
   *   · `loopback` (el default) — Node como proceso del host, con nginx en la
   *     MISMA máquina como única puerta. Express confía solo en un proxy que
   *     venga de 127.0.0.1, o sea nginx, y toma el valor que nginx puso
   *     ($remote_addr, la IP real). Se apoya en dos patas que están en deploy/:
   *     nginx PISA X-Forwarded-For (no lo concatena) y Node escucha SOLO en
   *     localhost (HOST=127.0.0.1).
   *
   *   · `1` — en Docker/Dokploy, donde el proxy es Traefik. Traefik es OTRO
   *     CONTENEDOR de la red de Docker, así que su IP no es 127.0.0.1 y
   *     `loopback` NO le cree: `req.ip` quedaría en la IP interna de la red,
   *     idéntica para todos, y el freno del login pasaría a contar a todos los
   *     visitantes como uno solo. Con `1`, Express confía en un solo salto —el
   *     de Traefik— y devuelve la IP que Traefik escribió.
   *
   * Y ACÁ ESTÁ LA CONDICIÓN QUE HACE QUE `1` SEA SEGURO: el puerto del
   * contenedor NO se publica al host. Si se publica, cualquiera puede hablarle
   * a Node directo con un X-Forwarded-For inventado y Express se lo va a creer,
   * porque para él ese cliente ES el primer salto. Con el puerto cerrado, el
   * único que puede llegar es Traefik y la falsificación no tiene por dónde.
   *
   * Es la misma decisión de siempre —confiar en el proxy y en nadie más—, pero
   * el "quién es el proxy" cambia con la forma de desplegar. Ver deploy/DEPLOY.md.
   */
  const trustProxyCrudo = (config.get<string>('TRUST_PROXY') ?? 'loopback').trim();
  // Un `1` que llega como texto tiene que entrar como número: Express distingue
  // el conteo de saltos (número) del nombre de una red (texto).
  const trustProxy = /^\d+$/.test(trustProxyCrudo) ? Number(trustProxyCrudo) : trustProxyCrudo;
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000,http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // exposedHeaders: sin esto el fetch del dashboard no puede LEER el
  // Content-Disposition y la descarga del respaldo pierde su nombre con fecha.
  app.enableCors({ origin: origins, credentials: true, exposedHeaders: ['Content-Disposition'] });

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
