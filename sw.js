/* Guarda las fotos en el equipo para que aparezcan al instante, y pide siempre la página más nueva */
const CACHE = "sw-fotos-v1";
const PAGINA = "sw-pagina-v1";
const esFoto = u => (u.origin === self.location.origin && u.pathname.includes("/img/") && !u.pathname.endsWith(".json"))
                 || u.pathname.endsWith("/api/foto") || u.hostname === "lh3.googleusercontent.com";

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(guardarTodas());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("sw-fotos-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => { if (e.data === "actualizar-fotos") e.waitUntil(guardarTodas()); });

async function guardarTodas(){
  try{
    const r = await fetch("img/index.json", {cache: "no-cache"});
    const idx = await r.json();
    const urls = [...new Set(Object.values(idx))].map(u => new URL(u, self.registration.scope).href);
    const c = await caches.open(CACHE);
    // borra versiones viejas de las fotos del repositorio
    for (const req of await c.keys()){
      const u = new URL(req.url);
      if (u.origin === self.location.origin && !urls.includes(req.url)) await c.delete(req);
    }
    let i = 0;
    const worker = async () => { while (i < urls.length){ const u = urls[i++]; if (!(await c.match(u))) { try{ await c.add(u); }catch(err){} } } };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }catch(err){}
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  // La página: siempre la versión más nueva de internet (sin la copia de 10 min); sin internet, la última guardada
  if (req.mode === "navigate" && u.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(PAGINA);
      try {
        const res = await fetch(req.url, {cache: "no-store", credentials: "same-origin"});
        if (res && res.ok) c.put(u.pathname, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        return (await c.match(u.pathname)) || Response.error();
      }
    })());
    return;
  }
  if (!esFoto(u)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, {ignoreVary: true});
    if (hit) return hit;
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()).catch(() => {});
    return res;
  })());
});
