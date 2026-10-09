/**
 * Cotizador Sharewow — servidor en Netlify.
 * Guarda la clave, la configuración (botones, precios, cartoon), las cotizaciones y las fotos
 * en Netlify Blobs, y envía la cotización en PDF al cliente desde el correo de Titan.
 *
 * Variables que se ponen en Netlify (Site configuration → Environment variables):
 *   TITAN_USUARIO  correo de Titan desde el que se envía (ej. Plazalosdominicos@sharewow.cl)
 *   TITAN_CLAVE    contraseña de ese correo
 *   CLAVE_APP      (opcional) patrón inicial como números de los puntos (1 2 3 / 4 5 6 / 7 8 9), solo si aún no hay clave
 */
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { sendMail } from "../lib/smtp.mjs";

const PREFIJO_CLAVE = "sharewow-tienda";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const store = () => getStore({ name: "cotizador", consistency: "strong" });
const sha = t => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const env = k => (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get(k)) || process.env[k] || "";

async function acceso(st) {
  let a = await st.get("acceso", { type: "json" });
  const inicial = env("CLAVE_APP").trim();
  if (!a && /^\d{4,9}$/.test(inicial)) {
    const salt = crypto.randomBytes(6).toString("hex");
    a = { salt, hash: sha(PREFIJO_CLAVE + salt + inicial) };
    await st.setJSON("acceso", a);
  }
  return a;
}

async function listarCotizaciones(st) {
  const { blobs } = await st.list({ prefix: "cot/" });
  const keys = blobs.map(b => b.key);
  const out = [];
  for (let i = 0; i < keys.length; i += 25) {
    const parte = await Promise.all(keys.slice(i, i + 25).map(k => st.get(k, { type: "json" }).catch(() => null)));
    parte.forEach(r => { if (r) out.push(r); });
  }
  out.sort((a, b) => (b.creado || 0) - (a.creado || 0));
  return out;
}

async function guardarCotizacion(st, rec, enviada) {
  if (!rec || !rec.id || !/^[A-Za-z0-9_-]{1,80}$/.test(rec.id)) throw new Error("bad_request");
  const k = "cot/" + rec.id;
  const prev = await st.get(k, { type: "json" }).catch(() => null);
  const r = { ...rec, _enviada: enviada ? Date.now() : (prev && prev._enviada) || null };
  await st.setJSON(k, r);
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plata = n => n == null ? "Consultar" : "$" + Math.round(Number(n)).toLocaleString("es-CL");

function htmlCorreo(rec, e) {
  const filas = (rec.lines || []).map(l =>
    `<tr><td style="padding:6px 10px;${l.ind ? "color:#62657A;padding-left:24px" : ""}">${l.ind ? "+ " : ""}${esc(l.d)}</td>` +
    `<td style="padding:6px 10px;text-align:right;white-space:nowrap">${plata(l.v)}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;color:#16171D;max-width:560px">` +
    `<p>Hola ${esc(rec.cliente || "")},</p>` +
    `<p>Te enviamos la cotización <b>N° ${esc(rec.numero)}</b> de Sharewow. Va adjunta en PDF.</p>` +
    `<p style="margin:16px 0 6px"><b>${esc(rec.titulo)}</b></p>` +
    `<table style="border-collapse:collapse;width:100%;border:1px solid #DCE3DD">${filas}` +
    `<tr style="background:#3BB33E;color:#fff"><td style="padding:8px 10px"><b>TOTAL</b></td><td style="padding:8px 10px;text-align:right"><b>${plata(rec.total)}</b></td></tr></table>` +
    (rec.vigencia ? `<p style="color:#62657A">Esta cotización tiene una validez de ${esc(rec.vigencia)} días.</p>` : "") +
    `<p>Saludos,<br>${rec.vendedor ? esc(rec.vendedor) + "<br>" : ""}` +
    [e.razon, e.dir1, e.dir2, e.web, e.correo, e.telefono].filter(Boolean).map(esc).join("<br>") + `</p></div>`;
}

async function atender(req, origen) {
  const st = store();
  const a = req.action;

  // ---- Público ----
  if (a === "boot") {
    const [acc, menu, precios, cartoon, fotos] = await Promise.all([
      acceso(st), st.get("config/menu", { type: "json" }), st.get("config/precios", { type: "json" }),
      st.get("config/cartoon", { type: "json" }), st.get("fotos", { type: "json" })
    ]);
    return { config: { menu, precios, cartoon }, fotos: fotos || {}, salt: acc ? acc.salt : null, hayClave: !!acc };
  }
  if (a === "login") {
    const acc = await acceso(st);
    return { valida: !!acc && req.hash === acc.hash };
  }
  if (a === "setPin") {
    const acc = await acceso(st);
    if (acc && req.anterior !== acc.hash) throw new Error("clave_incorrecta");
    if (!req.salt || !/^[a-f0-9]{64}$/.test(req.hash || "")) throw new Error("bad_request");
    await st.setJSON("acceso", { salt: String(req.salt), hash: req.hash });
    return {};
  }

  // ---- Requiere clave ----
  const acc = await acceso(st);
  if (!acc || req.token !== acc.hash) throw new Error("no_autorizado");

  if (a === "setDoc") {
    if (!["menu", "precios", "cartoon"].includes(req.key)) throw new Error("bad_request");
    await st.setJSON("config/" + req.key, req.data);
    return {};
  }
  if (a === "img") {
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(req.src || "");
    if (!m || !/^[A-Za-z0-9_-]{1,200}$/.test(req.key || "")) throw new Error("imagen_invalida");
    const bytes = Buffer.from(m[2], "base64");
    const v = sha(m[2]).slice(0, 10);
    await st.set("foto/" + req.key, bytes, { metadata: { type: m[1], v } });
    const url = `${origen}/api/foto?k=${encodeURIComponent(req.key)}&v=${v}`;
    const fotos = (await st.get("fotos", { type: "json" })) || {};
    fotos[req.key] = url;
    await st.setJSON("fotos", fotos);
    return { url };
  }
  if (a === "imgDel") {
    const fotos = (await st.get("fotos", { type: "json" })) || {};
    fotos[req.key] = "";
    await st.setJSON("fotos", fotos);
    await st.delete("foto/" + req.key).catch(() => {});
    return {};
  }
  if (a === "quotes") return { quotes: await listarCotizaciones(st) };
  if (a === "saveQuote") { await guardarCotizacion(st, req.rec, false); return {}; }
  if (a === "delQuote") {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(req.id || "")) throw new Error("bad_request");
    await st.delete("cot/" + req.id); return {};
  }
  if (a === "email") {
    const rec = req.rec || {};
    if (!rec.correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.correo)) throw new Error("correo_invalido");
    if (!req.pdf) throw new Error("sin_pdf");
    const usuario = env("TITAN_USUARIO").trim(), clave = env("TITAN_CLAVE");
    if (!usuario || !clave) throw new Error("correo_no_configurado");
    const e = req.empresa || {};
    await sendMail({
      host: env("SMTP_HOST") || "smtp.titan.email",
      port: Number(env("SMTP_PORT") || 465),
      insecure: env("SMTP_INSEGURO") === "1",
      user: usuario, pass: clave, fromName: "Sharewow",
      to: rec.correo, bcc: [usuario], replyTo: e.correo || usuario,
      subject: "Cotización Sharewow N° " + (rec.numero || ""),
      html: htmlCorreo(rec, e),
      attachment: { base64: req.pdf, filename: req.filename || ("Cotizacion " + rec.numero + ".pdf"), type: "application/pdf" }
    });
    await guardarCotizacion(st, rec, true);
    return {};
  }
  throw new Error("accion_desconocida");
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const origen = url.origin;

  if (request.method === "GET") {
    // Foto guardada desde la página
    if (url.pathname.endsWith("/api/foto")) {
      const k = url.searchParams.get("k") || "";
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(k)) return new Response("not found", { status: 404, headers: CORS });
      const r = await store().getWithMetadata("foto/" + k, { type: "arrayBuffer" });
      if (!r) return new Response("not found", { status: 404, headers: CORS });
      return new Response(r.data, { headers: { ...CORS, "Content-Type": (r.metadata && r.metadata.type) || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
    }
    // Estado (para revisar que todo esté bien conectado; no muestra datos privados)
    let blobs = false;
    try { await store().get("acceso"); blobs = true; } catch (e) {}
    return json({ ok: true, app: "cotizador-sharewow", guardado: blobs, correo: !!(env("TITAN_USUARIO") && env("TITAN_CLAVE")) });
  }

  let req;
  try { req = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: "bad_request" }); }
  try {
    const res = (await atender(req, origen)) || {};
    res.ok = true;
    return json(res);
  } catch (err) {
    const code = String((err && err.message) || err);
    if (code.startsWith("smtp") || code === "correo_no_configurado") console.error("correo:", code, err && err.detail || "");
    return json({ ok: false, error: code });
  }
};

export const config = { path: ["/api", "/api/foto"] };
