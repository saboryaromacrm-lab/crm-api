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

> ⚠️ Hoy la API no tiene autenticación y solo debe usarse en la red local.
> Cuando el CRM active sesiones, coffit va a recibir un token de solo lectura
> para estas rutas; el contrato de datos no cambia.

### `GET /cafeteria/sync?desde=<ISO>` — el que hay que usar

Devuelve **todo lo que cambió** desde el cursor `desde`: envíos creados,
editados y **anulados**, con su detalle completo, ordenados por fecha de
cambio. Sin `desde` devuelve todo el historial (máximo 200 por llamada).

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

El cursor lo pone **el reloj del CRM** (por eso se usa el `ahora` de la
respuesta y no la hora de coffit): relojes desfasados no abren agujeros.
Si vienen 200 envíos justos, hay más: repetir con el `actualizadoEn` del
último antes de dar por terminada la vuelta.

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
- [ ] Cursor persistido con el `ahora` de cada respuesta.
- [ ] Registro `(id, version)` de lo procesado; reprocesos idempotentes.
- [ ] Edición → deshacer y re-aplicar; anulación → deshacer.
- [ ] Contraste de `totalKg` contra la interpretación propia de `cantidad`.
- [ ] Los ingresos al almacén "Sabor y Aroma" valorizados con `costoUnitario`.
