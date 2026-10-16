/**
 * CACHÉ CORTO EN MEMORIA (16/10/2026): el catálogo de la tienda se armaba de
 * cero en CADA visita (unas 20 consultas). Con público minorista entrando desde
 * las redes, eso era el cuello de botella —y de la misma base viven la caja y
 * el ERP—. Ahora se arma una vez cada `ttlMs` y todos reciben esa copia.
 *
 *   · Fresco: se contesta de memoria.
 *   · Vencido: se contesta con la copia vieja YA y se renueva por detrás
 *     (nadie espera la consulta), una sola renovación aunque entren cien.
 *   · Sin copia: se arma y se espera; los que llegan mientras tanto esperan la
 *     misma promesa.
 */
export class CacheCorto<T> {
  private readonly entradas = new Map<string, { valor: T; vence: number }>();
  private readonly enVuelo = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number) {}

  async get(clave: string, armar: () => Promise<T>): Promise<T> {
    const e = this.entradas.get(clave);
    if (e && e.vence > Date.now()) return e.valor;
    const p = this.enVuelo.get(clave) ?? this.renovar(clave, armar);
    if (!e) return p;
    p.catch(() => { /* se sigue sirviendo la copia vieja; el próximo pedido reintenta */ });
    return e.valor;
  }

  private renovar(clave: string, armar: () => Promise<T>) {
    const p = armar()
      .then((valor) => { this.entradas.set(clave, { valor, vence: Date.now() + this.ttlMs }); return valor; })
      .finally(() => this.enVuelo.delete(clave));
    this.enVuelo.set(clave, p);
    return p;
  }

  invalidar() { this.entradas.clear(); }
}
