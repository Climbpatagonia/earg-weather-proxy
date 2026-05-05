import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

// Cache de 3 minutos (180 segundos)
const weatherCache = new NodeCache({ stdTTL: 180 });

const COMPASS_POINTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];

// ─── UTILIDADES DE EXTRACCIÓN ───────────────────────────────────────────────

function extractValue(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  return match && match[1] ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : null;
}

function kmhToKnots(value) {
  if (!value) return null;
  const n = parseFloat(value.replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : (n * 0.539957).toFixed(1);
}

function parseWeatherData(html) {
  return {
    updatedAt: new Date().toISOString(),
    temperature: extractValue(html, 'outtemp'),
    feelsLike: extractValue(html, 'feelslike'),
    windSpeed: extractValue(html, 'curwindspeed'),
    windGust: extractValue(html, 'curwindgust'),
    windDir: extractValue(html, 'curwinddir'),
    pressure: extractValue(html, 'barometer'),
    humidity: extractValue(html, 'outHumidity'),
    rain: extractValue(html, 'dayRain'),
  };
}

// ─── RUTAS ──────────────────────────────────────────────────────────────────

// AHORA LA RAÍZ MUESTRA LA TABLA (VIEW)
app.get('/', async (req, res) => {
  try {
    const cacheKey = "html_view";
    let data = weatherCache.get(cacheKey);

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
        <title>EARG - Clima</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h1 { color: #7dd3fc; font-size: 1.2rem; margin-bottom: 1rem; text-align: center; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 10px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'}</td></tr>
          </table>
          <p style="font-size: 0.7rem; color: #475569; margin-top: 1rem; text-align: center;">Actualizado: ${new Date(data.updatedAt).toLocaleTimeString()}</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(502).send("Error conectando con la estación local.");
  }
});

// Endpoint JSON para Garmin
app.get('/weather', async (req, res) => {
  const cacheKey = "weather_json";
  let data = weatherCache.get(cacheKey);
  if (data) return res.json(data);

  try {
    const response = await axios.get(SOURCE_URL);
    data = parseWeatherData(response.data);
    weatherCache.set(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "No disponible" });
  }
});

// ─── WINDGURU ───────────────────────────────────────────────────────────────
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
      temperature: d.temperature?.replace(/[^0-9.-]/g, '')
    });
    await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
  } catch (err) { console.error('Windguru error'); }
}
setInterval(uploadToWindguru, 60000);

app.listen(PORT, () => console.log(`Online on port ${PORT}`));
