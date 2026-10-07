# Cotizador Sharewow

Página para sacar precios y generar cotizaciones de Sharewow (figuras en cabina y figuras cartoon).

- `index.html` — la página.
- `config.js` — URL de la conexión con Google (Apps Script).
- `img/` — fotos de los botones. `img/index.json` dice qué foto va en cada botón.
- `apps-script/Code.gs` — el servidor en Google: guarda precios, fotos y cotizaciones en una hoja de Google y envía la cotización en PDF por correo.

Los datos de los clientes no se guardan en este repositorio; quedan en la hoja de Google de la tienda.
