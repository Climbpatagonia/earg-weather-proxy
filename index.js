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

// Caché de 3 minutos
const weatherCache = new NodeCache({ stdTTL: 180 });

// ─── FUNCIONES DE EXTRACCIÓN ───────────────────────────────────────────────

function extractValue(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  if (!match || !match[1]) return null;
  return match[1].replace(/&deg;|&#176;|°/g, '').trim();
}

function kmhToKnots(value) {
  if (!value) return null;
  const normalized = value.replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

function parseWeatherData(html) {
  return {
    // EXTRAEMOS LA HORA REAL DE LA PÁGINA (clase 'lastupdate')
    stationTime: extractValue(html, 'lastupdate'), 
    temperature: extractValue(html, 'outtemp'),
    feelsLike:   (extractValue(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
    windSpeed:   extractValue(html, 'curwindspeed'),
    windGust:    extractValue(html, 'curwindgust'),
    windDir:     extractValue(html, 'curwinddir'),
    pressure:    extractValue(html, 'barometer'),
    humidity:    extractValue(html, 'outHumidity'),
    rain:        extractValue(html, 'dayRain'),
  };
}

// ─── RUTA PRINCIPAL (HTML) ──────────────────────────────────────────────────

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
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="180">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EARG - Clima</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem 1rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h1 { color: #7dd3fc; font-size: 1.2rem; margin-bottom: 0.25rem; text-align: center; }
          .subtitle { font-size: 0.8rem; color: #64748b; text-align: center; margin-bottom: 1.5rem; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 12px 8px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: bold; }
          .updated { font-size: 0.75rem; color: #6366f1; margin-top: 1.5rem; text-align: center; background: #1e1b4b; padding: 5px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <p class="subtitle">Datos oficiales EARG</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'}</td></tr>
          </table>
          <p class="updated">Última lectura estación: ${data.stationTime || 'Consultando...'}</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(502).send("Error de conexión con la estación.");
  }
});

// ─── ENDPOINT JSON & WINDGURU ───────────────────────────────────────────────

app.get('/weather', async (req, res) => {
  let data = weatherCache.get("weather_json");
  if (data) return res.json(data);
  try {
    const response = await axios.get(SOURCE_URL);
    data = parseWeatherData(response.data);
    weatherCache.set("weather_json", data);
    res.json(data);
  } catch (e) { res.status(502).json({ error: "No disponible" }); }
});

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
      temperature: (d.temperature || '').replace(/[^0-9.-]/g, '')
    });
    await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
  } catch (err) { console.error('Windguru sync fail'); }
}

setInterval(uploadToWindguru, 60000);
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
