// Cliente SMTP mínimo (sin dependencias) para enviar por Titan.
// Conecta por TLS (puerto 465), se autentica y envía un mensaje MIME con un PDF adjunto.
import tls from "node:tls";
import crypto from "node:crypto";

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const encHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const wrap76 = s => s.replace(/.{1,76}/g, "$&\r\n");
const cleanAddr = s => String(s || "").replace(/[\r\n<>"]/g, "").trim();

function reader(socket) {
  let buf = "", waiting = null, lines = [];
  const pump = () => {
    if (!waiting) return;
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2); lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const w = waiting; waiting = null; const all = lines; lines = [];
        w.resolve({ code: Number(line.slice(0, 3)), lines: all });
        return;
      }
    }
  };
  socket.on("data", d => { buf += d.toString("utf8"); pump(); });
  socket.on("error", e => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } });
  socket.on("close", () => { if (waiting) { const w = waiting; waiting = null; w.reject(new Error("smtp_cerrado")); } });
  return () => new Promise((resolve, reject) => { waiting = { resolve, reject }; pump(); });
}

export async function sendMail(opts) {
  const {
    host = "smtp.titan.email", port = 465, user, pass, insecure = false,
    fromName = "Sharewow", to, bcc = [], replyTo, subject, html, attachment
  } = opts;
  if (!user || !pass) throw new Error("correo_no_configurado");
  const from = cleanAddr(user);
  const rcpts = [cleanAddr(to), ...bcc.map(cleanAddr)].filter(Boolean);

  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: !insecure });
  socket.setTimeout(20000, () => socket.destroy(new Error("smtp_tiempo")));
  const next = reader(socket);
  const write = s => socket.write(s + "\r\n");
  const expect = async (cmd, ok) => {
    if (cmd != null) write(cmd);
    const r = await next();
    if (!ok.includes(r.code)) { const e = new Error(r.code === 535 ? "smtp_auth" : "smtp_" + r.code); e.detail = r.lines.join(" | "); throw e; }
    return r;
  };
  try {
    await new Promise((res, rej) => { socket.once("secureConnect", res); socket.once("error", rej); });
    await expect(null, [220]);
    const ehlo = await expect("EHLO sharewow.cl", [250]);
    const caps = ehlo.lines.join(" ").toUpperCase();
    if (caps.includes("AUTH") && /AUTH[ =][^\r\n]*PLAIN/.test(caps)) {
      await expect("AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64"), [235]);
    } else {
      await expect("AUTH LOGIN", [334]);
      await expect(b64(user), [334]);
      await expect(b64(pass), [235]);
    }
    await expect(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await expect(`RCPT TO:<${r}>`, [250, 251]);
    await expect("DATA", [354]);

    const boundary = "sw_" + crypto.randomBytes(12).toString("hex");
    const head = [
      `From: ${encHeader(fromName)} <${from}>`,
      `To: <${cleanAddr(to)}>`,
      replyTo && cleanAddr(replyTo).toLowerCase() !== from.toLowerCase() ? `Reply-To: <${cleanAddr(replyTo)}>` : null,
      `Subject: ${encHeader(subject || "")}`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1] || "sharewow.cl"}>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    ].filter(Boolean).join("\r\n");
    let body = `${head}\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html || ""))}`;
    if (attachment && attachment.base64) {
      const fname = attachment.filename || "cotizacion.pdf";
      body += `--${boundary}\r\nContent-Type: ${attachment.type || "application/pdf"}; name="${encHeader(fname)}"\r\n` +
        `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${encHeader(fname)}"\r\n\r\n` +
        wrap76(attachment.base64.replace(/\s+/g, ""));
    }
    body += `--${boundary}--\r\n`;
    // "dot-stuffing" por seguridad
    body = body.split("\r\n").map(l => l.startsWith(".") ? "." + l : l).join("\r\n");
    socket.write(body);
    await expect(".", [250]);
    try { write("QUIT"); } catch (e) {}
    return { ok: true };
  } finally {
    setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 50);
  }
}
