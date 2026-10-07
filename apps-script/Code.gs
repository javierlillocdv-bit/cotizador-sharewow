/**
 * Cotizador Sharewow — servidor en Google Apps Script.
 *
 * Guarda en una hoja de Google: la configuración (botones, precios, cartoon),
 * las cotizaciones y las fotos subidas desde la página (las fotos van a Drive).
 * También envía la cotización en PDF al correo del cliente.
 *
 * Cómo instalarlo (una sola vez):
 *  1. script.google.com → Nuevo proyecto → pega este archivo completo.
 *  2. Elige la función "instalar" arriba y toca ▶ Ejecutar. Acepta los permisos.
 *  3. Implementar → Nueva implementación → tipo "Aplicación web".
 *     Ejecutar como: Yo. Quién tiene acceso: Cualquier persona.
 *  4. Copia la URL que termina en /exec y pásala para ponerla en la página.
 */

const PREFIJO_CLAVE = 'sharewow-tienda';

/* =================== Datos iniciales (se usan solo en "instalar") =================== */
// Se completan al preparar el archivo; si están vacíos, la página parte con sus valores de fábrica.
const DATOS_INICIALES = /*DATOS_INICIALES*/{}/*FIN*/;

/* =================== Instalación =================== */
function instalar() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty('SHEET_ID');
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Cotizador Sharewow — datos');
    props.setProperty('SHEET_ID', ss.getId());
  }
  hoja_(ss, 'Config', ['clave', 'json', 'actualizado']);
  hoja_(ss, 'Cotizaciones', ['id', 'fecha', 'numero', 'vendedor', 'cliente', 'telefono', 'correo', 'total', 'producto', 'enviada', 'json']);
  hoja_(ss, 'Fotos', ['clave', 'url', 'actualizado']);
  const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!props.getProperty('FOLDER_ID')) {
    const folder = DriveApp.createFolder('Cotizador Sharewow — fotos');
    props.setProperty('FOLDER_ID', folder.getId());
  }

  // Cargar datos iniciales solo si no existen todavía
  const d = DATOS_INICIALES || {};
  if (d.acceso && !props.getProperty('PIN_HASH')) {
    props.setProperty('PIN_SALT', d.acceso.salt);
    props.setProperty('PIN_HASH', d.acceso.hash);
  }
  ['menu', 'precios', 'cartoon'].forEach(function (k) {
    if (d[k] && getConfig_(k) == null) setConfig_(k, d[k]);
  });
  if (d.cotizaciones && d.cotizaciones.length) {
    const existentes = {};
    listarCotizaciones_().forEach(function (r) { existentes[r.id] = true; });
    d.cotizaciones.forEach(function (r) { if (!existentes[r.id]) guardarCotizacion_(r, false); });
  }
  // Probar permiso de correo (pide autorización la primera vez)
  MailApp.getRemainingDailyQuota();
  Logger.log('Listo. Hoja: ' + ss.getUrl());
}

/* =================== Entrada web =================== */
function doGet() {
  return json_({ ok: true, app: 'cotizador-sharewow' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  try {
    const res = atender_(req) || {};
    res.ok = true;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function atender_(req) {
  const a = req.action;
  const props = PropertiesService.getScriptProperties();

  // ---- Público ----
  if (a === 'boot') {
    return {
      config: { menu: getConfig_('menu'), precios: getConfig_('precios'), cartoon: getConfig_('cartoon') },
      fotos: listarFotos_(),
      salt: props.getProperty('PIN_SALT') || null,
      hayClave: !!props.getProperty('PIN_HASH')
    };
  }
  if (a === 'login') {
    return { valida: !!props.getProperty('PIN_HASH') && req.hash === props.getProperty('PIN_HASH') };
  }
  if (a === 'setPin') {
    const actual = props.getProperty('PIN_HASH');
    if (actual && req.anterior !== actual) throw new Error('clave_incorrecta');
    if (!req.salt || !req.hash) throw new Error('bad_request');
    props.setProperty('PIN_SALT', req.salt);
    props.setProperty('PIN_HASH', req.hash);
    return {};
  }

  // ---- Requiere clave ----
  if (!props.getProperty('PIN_HASH') || req.token !== props.getProperty('PIN_HASH')) throw new Error('no_autorizado');

  if (a === 'setDoc') {
    if (['menu', 'precios', 'cartoon'].indexOf(req.key) < 0) throw new Error('bad_request');
    setConfig_(req.key, req.data);
    return {};
  }
  if (a === 'img') return { url: guardarFoto_(req.key, req.src) };
  if (a === 'imgDel') { setFoto_(req.key, ''); return {}; }
  if (a === 'quotes') return { quotes: listarCotizaciones_() };
  if (a === 'saveQuote') { guardarCotizacion_(req.rec, false); return {}; }
  if (a === 'delQuote') { borrarCotizacion_(req.id); return {}; }
  if (a === 'email') { enviarCorreo_(req); return {}; }
  throw new Error('accion_desconocida');
}

/* =================== Hoja =================== */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('sin_instalar');
  return SpreadsheetApp.openById(id);
}
function hoja_(ss, nombre, encabezados) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, encabezados.length).setValues([encabezados]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function buscarFila_(sh, valor) {
  const n = sh.getLastRow();
  if (n < 2) return -1;
  const col = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < col.length; i++) if (String(col[i][0]) === String(valor)) return i + 2;
  return -1;
}

/* ---- Config ---- */
function getConfig_(k) {
  const sh = ss_().getSheetByName('Config');
  const f = buscarFila_(sh, k);
  if (f < 0) return null;
  const v = sh.getRange(f, 2).getValue();
  try { return JSON.parse(v); } catch (e) { return null; }
}
function setConfig_(k, data) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = ss_().getSheetByName('Config');
    const f = buscarFila_(sh, k);
    const fila = [k, JSON.stringify(data), new Date()];
    if (f < 0) sh.appendRow(fila); else sh.getRange(f, 1, 1, 3).setValues([fila]);
  } finally { lock.releaseLock(); }
}

/* ---- Fotos ---- */
function listarFotos_() {
  const sh = ss_().getSheetByName('Fotos');
  const n = sh.getLastRow(); const out = {};
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, 2).getValues().forEach(function (r) { out[r[0]] = r[1]; });
  return out;
}
function setFoto_(k, url) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = ss_().getSheetByName('Fotos');
    const f = buscarFila_(sh, k);
    const fila = [k, url, new Date()];
    if (f < 0) sh.appendRow(fila); else sh.getRange(f, 1, 1, 3).setValues([fila]);
  } finally { lock.releaseLock(); }
}
function guardarFoto_(k, src) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(src || '');
  if (!m) throw new Error('imagen_invalida');
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], k + '.' + ext);
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  setFoto_(k, url);
  return url;
}

/* ---- Cotizaciones ---- */
function listarCotizaciones_() {
  const sh = ss_().getSheetByName('Cotizaciones');
  const n = sh.getLastRow();
  if (n < 2) return [];
  const rows = sh.getRange(2, 1, n - 1, 11).getValues();
  const out = [];
  rows.forEach(function (r) { try { out.push(JSON.parse(r[10])); } catch (e) {} });
  out.sort(function (a, b) { return (b.creado || 0) - (a.creado || 0); });
  return out;
}
function guardarCotizacion_(rec, enviada) {
  if (!rec || !rec.id) throw new Error('bad_request');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = ss_().getSheetByName('Cotizaciones');
    const f = buscarFila_(sh, rec.id);
    const fila = [rec.id, new Date(rec.creado || Date.now()), rec.numero || '', rec.vendedor || '', rec.cliente || '',
      rec.contacto || '', rec.correo || '', rec.total || 0, rec.titulo || '', enviada ? new Date() : '', JSON.stringify(rec)];
    if (f < 0) sh.appendRow(fila);
    else {
      if (!enviada) fila[9] = sh.getRange(f, 10).getValue();
      sh.getRange(f, 1, 1, 11).setValues([fila]);
    }
  } finally { lock.releaseLock(); }
}
function borrarCotizacion_(id) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = ss_().getSheetByName('Cotizaciones');
    const f = buscarFila_(sh, id);
    if (f > 0) sh.deleteRow(f);
  } finally { lock.releaseLock(); }
}

/* =================== Correo =================== */
function enviarCorreo_(req) {
  const rec = req.rec || {};
  if (!rec.correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.correo)) throw new Error('correo_invalido');
  if (!req.pdf) throw new Error('sin_pdf');
  const pdf = Utilities.newBlob(Utilities.base64Decode(req.pdf), 'application/pdf', req.filename || ('Cotizacion ' + rec.numero + '.pdf'));
  const e = req.empresa || {};
  const plata = function (n) { return n == null ? 'Consultar' : '$' + Math.round(Number(n)).toLocaleString('es-CL'); };
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const filas = (rec.lines || []).map(function (l) {
    return '<tr><td style="padding:6px 10px;' + (l.ind ? 'color:#62657A;padding-left:24px' : '') + '">' + (l.ind ? '+ ' : '') + esc(l.d) +
      '</td><td style="padding:6px 10px;text-align:right;white-space:nowrap">' + plata(l.v) + '</td></tr>';
  }).join('');
  const html =
    '<div style="font-family:Arial,sans-serif;color:#16171D;max-width:560px">' +
    '<p>Hola ' + esc(rec.cliente || '') + ',</p>' +
    '<p>Te enviamos la cotización <b>N° ' + esc(rec.numero) + '</b> de Sharewow. Va adjunta en PDF.</p>' +
    '<p style="margin:16px 0 6px"><b>' + esc(rec.titulo) + '</b></p>' +
    '<table style="border-collapse:collapse;width:100%;border:1px solid #DCE3DD">' + filas +
    '<tr style="background:#3BB33E;color:#fff"><td style="padding:8px 10px"><b>TOTAL</b></td><td style="padding:8px 10px;text-align:right"><b>' + plata(rec.total) + '</b></td></tr></table>' +
    (rec.vigencia ? '<p style="color:#62657A">Esta cotización tiene una validez de ' + esc(rec.vigencia) + ' días.</p>' : '') +
    '<p>Saludos,<br>' + (rec.vendedor ? esc(rec.vendedor) + '<br>' : '') +
    [e.razon, e.dir1, e.dir2, e.web, e.correo, e.telefono].filter(function (x) { return x; }).map(esc).join('<br>') + '</p></div>';
  const opts = { to: rec.correo, subject: 'Cotización Sharewow N° ' + rec.numero, htmlBody: html, name: 'Sharewow', attachments: [pdf] };
  if (e.correo) opts.replyTo = e.correo;
  MailApp.sendEmail(opts);
  guardarCotizacion_(rec, true);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
