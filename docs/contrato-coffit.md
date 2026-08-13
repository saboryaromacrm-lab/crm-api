# Contrato CRM → coffit: los envíos de Sabor y Aroma

**Para:** el desarrollador de coffit.
**Qué es:** cómo leer desde coffit los envíos de mercadería que la distribuidora
le hace a la cafetería, para ingresarlos al almacén **"Sabor y Aroma"** de coffit.
**Última actualización:** 9/8/2026.

## El modelo, en tres líneas

- El CRM registra el envío y **egresa el stock en el acto**, valorizado al costo
  del día (congelado). No hay etapas: enviado es enviado.
- Coffit ingresa todo al almacén "Sabor y Aroma" y **ahí decide** qué es cada
  cosa (producto de góndola, insumo de receta, lo que sea). El CRM no manda
  ninguna clasificación.
- Un envío ya enviado **puede editarse o anularse** en el CRM. Coffit se entera
  por el endpoint de sincronización y tiene que reaccionar (ver "Versiones").

## Los endpoints

Base local: `http://<ip-del-crm>:3001/api`

### Autenticación

La API del CRM **ya tiene sesiones**: todos sus endpoints exigen un usuario
logueado. Coffit no es una persona, así que tiene su propia llave.

**Mandá el secreto en la cabecera `X-Clave-Servicio`** en cada llamada a
`/cafeteria/sync`:

    X-Clave-Servicio: <el secreto que te pasa el dueño>

Esa clave abre **solo ese endpoint** — cualquier otra ruta del CRM le sigue
pidiendo sesión. No es un usuario, no vence y no sirve para nada más; si se
filtra, se cambia el valor en el CRM y listo.

> Mientras el dueño no cargue el secreto, `sync` sigue aceptando una sesión
> normal del CRM, así que el cambio se puede coordinar sin cortar el servicio.
> El contrato de datos no cambia en ninguno de los dos casos.

### `GET /cafeteria/sync?desde=<ISO>` — el que hay que usar

Devuelve **todo lo que cambió** desde el cursor `desde`: envíos creados,
editados y **anulados**, con su detalle completo, ordenados por fecha de
cambio. Sin `desde` devuelve todo el historial.

La respuesta trae como máximo **200 envíos**. Cuando se llena viene
`"hayMas": true`, y en ese caso **hay que volver a pedir enseguida** con el
`ahora` de esa misma respuesta, sin esperar al próximo ciclo — repitiendo hasta
que `hayMas` sea `false`.

> Antes esto perdía envíos en silencio: con más de 200 cambios, el `ahora` que
> devolvía el CRM era el reloj de pared, así que los que no habían entrado en la
> página quedaban *detrás* del cursor y no se devolvían nunca más. Si guardaste
> cursores de antes de este cambio, conviene pedir una vez sin `desde` para
> reconciliar.

```json
{
  "ahora": "2026-08-09T06:12:44.123Z",
  "envios": [
    {
      "id": 10,
      "codigo": "CAF0010",
      "fecha": "2026-08-09T03:00:00.000Z",
      "sucursalId": 1,
      "usuarioId": 2,
      "estado": "enviado",
      "totalCosto": 34459.34,
      "observaciones": "",
      "motivoAnulacion": "",
      "version": 2,
      "actualizadoEn": "2026-08-09T06:01:10.456Z",
      "pedidoId": 3,
      "items": [
        {
          "id": 15,
          "envioId": 10,
          "productoId": 28,
          "presentacionId": null,
          "modo": "granel",
          "cantidad": 8,
          "tamKg": 1,
          "totalKg": 8,
          "costoUnitario": 4307.4174900240005,
          "nombre": "Ajo en Polvo",
          "unidad": "kg",
          "codigoBarras": "",
          "codigoPropio": "ZZZ1002"
        }
      ]
    }
  ]
}
```

**El ciclo del cursor:**

1. Primera vez: `GET /cafeteria/sync` (sin `desde`). Procesar todo.
2. Guardar el campo `ahora` de la respuesta.
3. Cada vez que se sincronice: `GET /cafeteria/sync?desde=<ese ahora>`,
   procesar lo que venga, guardar el `ahora` nuevo.

El cursor lo pone **el CRM** (por eso se usa el `ahora` de la respuesta y no la
hora de coffit): relojes desfasados no abren agujeros.

Antes había que mirar si venían 200 justos y repetir a mano con el
`actualizadoEn` del último. **Eso ya no hace falta**: cuando la página se llena,
el `ahora` que devuelve el CRM *es* esa marca —no el reloj— y viene `hayMas:
true` para avisarlo. Alcanza con repetir el paso 3 mientras `hayMas` sea `true`.

### `GET /cafeteria/envios/:id`

Un envío puntual con el mismo formato. Útil para reconsultar o para cargar
uno escaneado del remito impreso (el código `CAF0010` lleva el id adentro).

## Cómo interpretar cada campo

### La clave del artículo: `productoId` + `presentacionId`

Es la **identidad estable**: seriales que nunca cambian. Coffit debe guardar su
tabla de equivalencias contra esta pareja — el matcheo se hace a mano una vez
por artículo, y no se rompe aunque el CRM renombre o recodifique el producto.

`nombre`, `codigoBarras` y `codigoPropio` viajan **solo como ayuda visual**
para la pantalla de matcheo. **Nunca mapear por nombre.**

### Las unidades: `modo`, `cantidad`, `tamKg`, `totalKg`

| `modo` | Qué significa `cantidad` | `tamKg` | `totalKg` |
|---|---|---|---|
| `granel` | **kilos** | 1 | = cantidad |
| `paquete` | **paquetes** de la presentación | kg por paquete (0.5 = 500 g) | = cantidad × tamKg |
| `unidad` | **unidades** de producto entero | 0 (no aplica) | `null` |

`totalKg` viaja ya calculado para poder **contrastar**: si coffit interpreta
`cantidad` y el total en kg no le cierra, algo se leyó mal. Un renglón
`modo: "paquete", cantidad: 10, tamKg: 0.5` son 10 paquetes = 5 kg — jamás
10 kg.

### El costo: `costoUnitario`

Congelado al enviar, en pesos, **por la unidad del `modo`** ($/kg, $/paquete o
$/unidad). Es el costo de reposición del café, para que coffit calcule su
margen. El precio de venta del café lo decide coffit — no copiar la lista de
la distribuidora.

### El origen del envío: `pedidoId`

La cafetería puede armar su **pedido** en el CRM (rol Cafetería, con el catálogo
completo a la vista). Cuando la distribuidora lo convierte en envío, el envío
viaja con `pedidoId` (null = envío espontáneo, sin pedido detrás). Es
**informativo**: le permite a coffit cruzar "esto que llegó responde a aquello
que se pidió". El detalle que vale es siempre el del ENVÍO — puede diferir de
lo pedido (faltantes, reemplazos).

## Versiones: cómo reaccionar a ediciones y anulaciones

El CRM puede **corregir** un envío ya enviado (cantidades, renglones) o
**anularlo**. Cada cambio sube `version` y el envío vuelve a aparecer en el
sync. Coffit debe guardar `(id, version)` de lo que ya procesó:

| Lo que llega | Qué hacer en coffit |
|---|---|
| `id` nuevo, `estado: "enviado"` | Ingresar al almacén "Sabor y Aroma". Registrar `(id, version)`. |
| `id` conocido, `version` mayor, `estado: "enviado"` | **Deshacer el ingreso anterior y aplicar el detalle nuevo** (el detalle viene completo, no como diferencia). Actualizar la versión registrada. |
| `id` conocido, `estado: "anulado"` | **Deshacer el ingreso** y marcarlo anulado. |
| `id` y `version` ya procesados | **No hacer nada.** Reprocesar no debe duplicar — esta idempotencia es la diferencia entre una integración estable y una que descuadra cada dos semanas. |
| `id` desconocido que llega directamente `anulado` | Registrarlo como visto y no ingresar nada. |

## Reglas que no se rediscuten

- Coffit es el dueño del stock del café; el CRM no lo espeja.
- El envío va **a costo**; la ganancia aparece cuando el café vende.
- La **clasificación** de la mercadería (góndola/insumo) es de coffit.
- El **precio de venta** del café es de coffit.

## Checklist del importador

- [ ] Tabla de equivalencias por `(productoId, presentacionId)` con matcheo manual.
- [ ] Clave de servicio en `X-Clave-Servicio` (no un usuario del CRM).
- [ ] Cursor persistido con el `ahora` de cada respuesta.
- [ ] Vuelta repetida mientras `hayMas` sea `true`.
- [ ] Registro `(id, version)` de lo procesado; reprocesos idempotentes.
- [ ] Edición → deshacer y re-aplicar; anulación → deshacer.
- [ ] Contraste de `totalKg` contra la interpretación propia de `cantidad`.
- [ ] Los ingresos al almacén "Sabor y Aroma" valorizados con `costoUnitario`.
