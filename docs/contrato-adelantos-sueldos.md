# Adelantos de sueldo para la app de sueldos

Solo lectura. Devuelve los adelantos de sueldo cargados en el ERP, tanto los de la caja central (Cash Flow › «Sacar plata») como los de la caja de cada local (Ventas › Caja › «Ingreso / egreso»).

## Pedido

```
GET https://api.saboryaroma.com/api/externo/adelantos?desde=2026-11-01&hasta=2026-11-30
X-Clave-Servicio: <valor de SUELDOS_API_KEY>
```

- `desde` / `hasta`: días `AAAA-MM-DD`, en hora de Argentina, con los dos extremos incluidos. Si no mandás ninguno, trae el mes en curso hasta hoy. Si mandás solo `hasta`, arranca el 1 de ese mes.
- La clave es la variable `SUELDOS_API_KEY` del servidor, que se carga en Dokploy. Mientras no esté cargada, este endpoint solo responde a una sesión del ERP con permiso de Cash Flow.

Respuestas:

| Código | Cuándo |
|---|---|
| `200` | Va el JSON de abajo |
| `400` | Fecha mal escrita, o `desde` posterior a `hasta` |
| `401` | Falta la clave o no coincide |

## Respuesta

```json
{
  "generado": "2026-11-06T14:39:03.392Z",
  "desde": "2026-11-01",
  "hasta": "2026-11-06",
  "conceptos": [{ "id": 4, "nombre": "Adelantos sueldos" }],
  "cantidad": 2,
  "total": 170000,
  "anulados": 1,
  "adelantos": [
    {
      "id": "cashflow-98",
      "origen": "cashflow",
      "movimientoId": 98,
      "fecha": "2026-11-06T02:59:59.000Z",
      "dia": "2026-11-05",
      "importe": 30000,
      "detalle": "Ana Gómez",
      "concepto": "Adelantos sueldos",
      "lugar": "Caja central (Cash Flow)",
      "sucursalId": null,
      "turnoCajaId": null,
      "cargadoPor": "Lucas",
      "anulado": true,
      "anuladoEn": "2026-11-06T14:39:03.104Z",
      "anuladoMotivo": "cargado dos veces",
      "empleado": null
    },
    {
      "id": "cashflow-97",
      "origen": "cashflow",
      "movimientoId": 97,
      "fecha": "2026-11-06T14:38:55.442Z",
      "dia": "2026-11-06",
      "importe": 150000,
      "detalle": "Juan Pérez · semana 1",
      "concepto": "Adelantos sueldos",
      "lugar": "Caja central (Cash Flow)",
      "sucursalId": null,
      "turnoCajaId": null,
      "cargadoPor": "Lucas",
      "anulado": false,
      "anuladoEn": null,
      "anuladoMotivo": null,
      "empleado": { "id": 3, "nombre": "Juan Pérez", "usuarioId": null }
    },
    {
      "id": "caja-86",
      "origen": "caja",
      "movimientoId": 86,
      "fecha": "2026-11-06T14:38:56.069Z",
      "dia": "2026-11-06",
      "importe": 20000,
      "detalle": "Sofía",
      "concepto": "Adelantos sueldos",
      "lugar": "Distribuidora",
      "sucursalId": 1,
      "turnoCajaId": 84,
      "cargadoPor": "Lucas",
      "anulado": false,
      "anuladoEn": null,
      "anuladoMotivo": null,
      "empleado": { "id": 2, "nombre": "Sofía", "usuarioId": 12 }
    }
  ]
}
```

### Campos de cada adelanto

| Campo | Qué es |
|---|---|
| `id` | **La clave única para no importar dos veces.** Es `cashflow-<n>` o `caja-<n>` y no cambia nunca. |
| `origen` | `cashflow` = caja central · `caja` = caja de un local |
| `fecha` | Fecha y hora exactas, en UTC (ISO 8601). |
| `dia` | El día en Argentina. Es el que conviene usar para el mes de liquidación. |
| `importe` | En pesos, siempre positivo. |
| `empleado` | **A quién se le dio.** `id` es el empleado en el ERP (no cambia nunca: usalo para enlazarlo en tu app), `nombre` su nombre de hoy y `usuarioId` el usuario del ERP si usa el sistema (`null` si no). Desde el 6/11/2026 es obligatorio elegirlo al sacar un adelanto; los adelantos de antes vienen con `null`. |
| `detalle` | El nombre del empleado y, después de « · », la nota que hayan escrito («Juan Pérez · semana 1»). En los de antes, solo lo que escribieron a mano. |
| `lugar` | «Caja central (Cash Flow)» o el nombre del local. |
| `turnoCajaId` | El turno de caja del local, si salió de un local. |
| `cargadoPor` | El usuario del ERP que lo cargó. |
| `anulado` / `anuladoEn` / `anuladoMotivo` | Si se anuló en el ERP. **Los anulados también vienen**, para que la app dé de baja uno que ya había importado. |

Totales:
- `total` y `cantidad` cuentan solo los adelantos no anulados.
- `anulados` es cuántos anulados vienen en la lista.

Orden de la lista: del más viejo al más nuevo.

### Qué cuenta como adelanto

Todo **egreso** con un concepto cuyo nombre diga «adelanto». Hoy ese concepto es «Adelantos sueldos». La lista `conceptos` de la respuesta muestra cuáles se tomaron en cuenta.

- Un concepto nuevo como «Adelanto aguinaldo» entra solo.
- Si se renombra un concepto y deja de decir «adelanto», sale de la lista.

## Cómo sincronizar

1. Pedir el mes que se liquida, o los últimos 2 o 3 meses para levantar anulaciones tardías.
2. Por cada adelanto, buscar su `id` en la app:
   - si no existe y `anulado` es `false`, crearlo;
   - si ya existe y ahora `anulado` es `true`, darlo de baja.
3. Asignar el empleado según `empleado.id`. Los empleados se cargan en el ERP en Gerencia › Usuarios › Empleados: los usuarios marcados «Es empleado» y los que no usan el sistema. Solo los adelantos anteriores al 6/11/2026 vienen sin `empleado`; para esos queda el `detalle`.
