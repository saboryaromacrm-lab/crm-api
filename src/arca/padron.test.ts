/*
 * CONSULTA DE CUIT (0125) — lo que se prueba acá es puro (sin red ni
 * certificado): el dígito verificador y la lectura de la respuesta de ARCA,
 * que es lo que decide si sale Factura A o B.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuitValido, interpretarPersona, ErrorPadron } from './padron';

const sobre = (cuerpo: string) => '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + `<ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn>${cuerpo}</personaReturn></ns2:getPersona_v2Response>`
  + '</soap:Body></soap:Envelope>';

const generales = (extra: string) => '<datosGenerales>'
  + '<domicilioFiscal><codPostal>3600</codPostal><descripcionProvincia>FORMOSA</descripcionProvincia>'
  + '<direccion>SARMIENTO 1314</direccion><localidad>FORMOSA</localidad><tipoDomicilio>FISCAL</tipoDomicilio></domicilioFiscal>'
  + `<estadoClave>ACTIVO</estadoClave><idPersona>30712345671</idPersona>${extra}</datosGenerales>`;

test('CUIT: dígito verificador', () => {
  assert.equal(cuitValido('23-35678242-9'), true);
  assert.equal(cuitValido('23356782429'), true);
  assert.equal(cuitValido('23356782428'), false, 'último dígito cambiado');
  assert.equal(cuitValido('2335678242'), false, '10 dígitos');
  assert.equal(cuitValido(''), false);
  assert.equal(cuitValido('30-71234567-1'), true);
});

test('Responsable Inscripto: impuesto 30 en el régimen general → Factura A', () => {
  const d = interpretarPersona(sobre(generales('<razonSocial>EMPRESA &amp; HIJOS SRL</razonSocial><tipoPersona>JURIDICA</tipoPersona>')
    + '<datosRegimenGeneral><impuesto><descripcionImpuesto>GANANCIAS SOCIEDADES</descripcionImpuesto><idImpuesto>10</idImpuesto></impuesto>'
    + '<impuesto><descripcionImpuesto>IVA</descripcionImpuesto><idImpuesto>30</idImpuesto></impuesto></datosRegimenGeneral>'), '30712345671');
  assert.equal(d.condicionIva, 'responsable_inscripto');
  assert.equal(d.nombre, 'EMPRESA & HIJOS SRL', 'la razón social desescapada');
  assert.equal(d.direccion, 'SARMIENTO 1314');
  assert.equal(d.localidad, 'FORMOSA');
  assert.equal(d.aviso, '');
});

test('Monotributista: datosMonotributo → monotributo (también Factura A desde RI)', () => {
  const d = interpretarPersona(sobre(generales('<apellido>PEREZ</apellido><nombre>JUAN</nombre><tipoPersona>FISICA</tipoPersona>')
    + '<datosMonotributo><categoriaMonotributo><descripcionCategoria>A LOCACIONES</descripcionCategoria><idCategoria>1</idCategoria></categoriaMonotributo>'
    + '<impuesto><idImpuesto>20</idImpuesto></impuesto></datosMonotributo>'), '20111111112');
  assert.equal(d.condicionIva, 'monotributo');
  assert.equal(d.nombre, 'PEREZ JUAN', 'persona física: apellido y nombre');
});

test('Exento (impuesto 32) y sin inscripción (consumidor final, con aviso)', () => {
  const ex = interpretarPersona(sobre(generales('<razonSocial>FUNDACION X</razonSocial>')
    + '<datosRegimenGeneral><impuesto><idImpuesto>32</idImpuesto></impuesto></datosRegimenGeneral>'), '30712345671');
  assert.equal(ex.condicionIva, 'exento');
  const cf = interpretarPersona(sobre(generales('<apellido>GOMEZ</apellido><nombre>ANA</nombre>')), '27111111113');
  assert.equal(cf.condicionIva, 'consumidor_final');
  assert.match(cf.aviso, /Factura B/);
});

test('Clave inactiva: se avisa', () => {
  const d = interpretarPersona(sobre(generales('<razonSocial>VIEJA SA</razonSocial>').replace('ACTIVO', 'INACTIVO')
    + '<datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto></impuesto></datosRegimenGeneral>'), '30712345671');
  assert.match(d.aviso, /inactivo/);
});

test('CUIT sin datos: error NO reintentable con el motivo de ARCA', () => {
  assert.throws(
    () => interpretarPersona(sobre('<errorConstancia><error>La clave consultada es inexistente</error><idPersona>20000000001</idPersona></errorConstancia>'), '20000000001'),
    (e: unknown) => e instanceof ErrorPadron && !e.reintentable && /inexistente/.test(e.message),
  );
});
