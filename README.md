# Cotizador Sharewow

Página para sacar precios y generar cotizaciones de Sharewow (figuras en cabina y figuras cartoon).

- `index.html` — la página (publicada en GitHub Pages).
- `config.js` — dirección del servidor (Netlify).
- `img/` — fotos de los botones. `img/index.json` dice qué foto va en cada botón.
- `sw.js` — guarda las fotos en el equipo para que aparezcan al instante.
- `netlify/functions/api.mjs` — el servidor en Netlify: guarda la clave, precios, fotos y cotizaciones
  (Netlify Blobs) y envía la cotización en PDF desde el correo de Titan.
- `netlify.toml`, `package.json` — configuración del servidor. Netlify solo vuelve a publicar
  cuando cambia algo de esta parte.

Variables en Netlify (Site configuration → Environment variables): `TITAN_USUARIO`, `TITAN_CLAVE`
y, opcional, `CLAVE_APP` (patrón inicial como números de los puntos: 1 2 3 / 4 5 6 / 7 8 9).

Los datos de los clientes, la clave y la contraseña del correo no se guardan en este repositorio.
