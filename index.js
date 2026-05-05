import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

// Configuración de puertos y URLs
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

// Configuración del caché: 180 segundos (3 minutos)
const weatherCache = new NodeCache({ stdTTL: 180 });

const COMPASS_POINTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];

// ─── FUNCIONES DE PROCESAMIENTO ──────────────────────────────────────────────

function extractValue(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  if (!match || !match[1]) return null;
  return match[1].replace(/&deg;|&#176;|°/g, '').trim();
}

function kmhToKnots(value) {
  if (!value) return null;
  const normalized = value.replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  if (!normalized.length) return null;
  return (parseFloat(normalized) * 0.539957).toFixed(1);
}

function parseWeatherData(html) {
  const outTemp    = extractValue(html, 'outtemp');
  const feelsLike  = extractValue(html, 'feelslike');
  const windSpeed  = extractValue(html, 'curwindspeed');
  const windGust   = extractValue(html, 'curwindgust');
  const windDir    = extractValue(html, 'curwinddir');
  const barometer  = extractValue(html, 'barometer');
  const humidity   = extractValue(html, 'outHumidity');
  const rain       = extractValue(html, 'dayRain');

  return {
    updatedAt:   new Date().toISOString(),
    temperature: outTemp ? outTemp.replace('°C', '').trim() : null,
    feelsLike:   feelsLike ? feelsLike.replace(/^ST:\s*/i, '').trim() : null,
    windSpeed:   windSpeed ? windSpeed.trim() : null,
    windGust:    windGust  ? windGust.trim()  : null,
    windDirection: windDir ? windDir.trim() : null,
    pressure:    barometer ? barometer.trim() : null,
    humidity:    humidity ? humidity.trim() : null,
    rain:        rain ? rain.trim() : null,
  };
}

// ─── RUTAS EXPRESS ───────────────────────────────────────────────────────────

// RUTA PRINCIPAL: Muestra la tabla HTML (Visualización)
app.get('/', async (req, res) => {
  const cacheKey = "html_view";
  let data = weatherCache.get(cacheKey);

  try {
    if (!data) {
      const response = await axios.get(SOURCE_URL, { timeout: 8000 });
      data = parseWeatherData(response.data);
      weatherCache.set(cacheKey, data);
    }

    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EARG - Clima Río Grande</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem 1rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h1 { color: #7dd3fc; font-size: 1.25rem; margin-bottom: 0.25rem; text-align: center; }
          .subtitle { font-size: 0.8rem; color: #64748b; text-align: center; margin-bottom: 1.5rem; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 12px 8px; border-bottom: 1px solid #334155; font-size: 1.05rem; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: bold; color: #f1f5f9; }
          .updated { font-size: 0.7rem; color: #475569; margin-top: 1.5rem; text-align: right; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Astronómica Río Grande</h1>
          <p class="subtitle">Datos meteorológicos en tiempo real</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDirection || '--'}</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'}</td></tr>
            <tr><td class="label">Lluvia diaria</td><td class="value">${data.rain || '--'}</td></tr>
          </table>
          <p class="updated">Actualizado: ${new Date(data.updatedAt).toLocaleTimeString('es-AR')}</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(502).send("Error: No se pudo conectar con la estación meteorológica.");
  }
});

// ENDPOINT JSON: Para aplicaciones como Garmin
app.get('/weather', async (req, res) => {
  const cacheKey = "weather_json";
  let data = weatherCache.get(cacheKey);

  if (data) return res.json(data);

  try {
    const response = await axios.get(SOURCE_URL);
    data = parseWeatherData(response.data);
    weatherCache.set(cacheKey, data);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: "Fuente no disponible" });
  }
});

// ─── WINDGURU UPLOAD ──────────────────────────────────────────────────────────

async function uploadToWindguru() {
  if (!WG_UID || !WG_PASSWORD) return;
  try {
    const response = await axios.get(SOURCE_URL);
    const d = parseWeatherData(response.data);
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);

    const params = new URLSearchParams({
      uid: WG_UID, salt, hash, interval: 60,
      wind_avg: kmhToKnots(d.windSpeed),
      wind_max: kmhToKnots(d.windGust),
      temperature: d.temperature?.replace(/[^0-9.-]/g, ''),
      rh: d.humidity?.replace(/[^0-9.-]/g, '')
    });

    await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
    console.log(`[Windguru] Datos enviados correctamente.`);
  } catch (err) {
    console.error('[Windguru] Error en el envío de datos.');
  }
}

// Iniciar ciclo de Windguru cada 60 segundos
setInterval(uploadToWindguru, 60000);

// ─── INICIO DEL SERVIDOR ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
