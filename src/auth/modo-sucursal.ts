/**
 * ¿El rol entra en cualquier sucursal y cambia desde el encabezado? (0224) Lo
 * dice su `modoSucursal` («libre»); el superadmin siempre (el comodín). Es solo
 * DÓNDE puede pararse: lo que puede hacer sobre otras sucursales sigue siendo
 * de `esJefe` (auth.guard).
 */
export function rolCruzaSucursales(rol: { modoSucursal?: string | null; permisos?: unknown } | null | undefined): boolean {
  return rol?.modoSucursal === 'libre' || (Array.isArray(rol?.permisos) && rol.permisos.includes('*'));
}
