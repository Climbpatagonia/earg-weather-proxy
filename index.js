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

// Cache de 5 minutos para no saturar la estación original
const weatherCache = new NodeCache({ stdTTL: 300 });

// --- FUNCIONES DE UTILIDAD ---

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
  let stationTime = extractValue(html, 'lastupdate');
  if (!stationTime) {
    stationTime = new Date().toLocaleTimeString('es-AR', { 
        timeZone: 'America/Argentina/Buenos_Aires', 
        hour: '2-digit', minute: '2-digit', hour12: false 
    }) + " hs";
  }

  return {
    stationTime,
    temperature: extractValue(html, 'outtemp'),
    feelsLike: (extractValue(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
    windSpeed: extractValue(html, 'curwindspeed'),
    windGust: extractValue(html, 'curwindgust'),
    windDir: extractValue(html, 'winddir') || extractValue(html, 'curwinddir') || "--",
    pressure: extractValue(html, 'barometer'),
    humidity: extractValue(html, 'outHumidity'),
    rain: extractValue(html, 'dayRain'),
  };
}

// --- ENDPOINTS ---

// 1. Endpoint específico para el Reloj Garmin (Monkey C)
app.get('/weather-view', async (req, res) => {
  let data = weatherCache.get("weather_data");
  if (!data) {
    try {
      const response = await axios.get(SOURCE_URL, { timeout: 8000 });
      data = parseWeatherData(response.data);
      weatherCache.set("weather_data", data);
    } catch (e) {
      return res.status(502).json({ error: "Error de conexión con la estación" });
    }
  }

  res.json({
    "temperature": data.temperature,
    "feelsLike": data.feelsLike,
    "windSpeed": data.windSpeed,
    "windGust": data.windGust,
    "windDirection": data.windDir,
    "stationTime": data.stationTime
  });
});

// 2. Endpoint general
app.get('/weather', (req, res) => {
  res.redirect('/weather-view');
});

// 3. Vista Web (Para ver desde el navegador)
app.get('/', async (req, res) => {
  let data = weatherCache.get("weather_data");
  try {
    if (!data) {
      const response = await axios.get(SOURCE_URL, { timeout: 10000 });
      data = parseWeatherData(response.data);
      weatherCache.set("weather_data", data);
    }
    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="300">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem 1rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1.2rem; width: 100%; max-width: 400px; border: 1px solid #334155; }
          h1 { color: #7dd3fc; font-size: 1.3rem; margin: 0; text-align: center; }
          .subtitle { 
            font-size: 0.85rem; color: #94a3b8; text-align: center; 
            margin-bottom: 0.5rem; padding-bottom: 1rem; border-bottom: 1px solid #334155; 
          }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          td { padding: 10px 8px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: 700; color: #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <p class="subtitle">Sincronización EARG - Garmin</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'} hPa</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'} %</td></tr>
            <tr><td class="label">Lluvia día</td><td class="value">${data.rain || '--'} mm</td></tr>
          </table>
          <p id="ping-status" style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
        </div>

        <script>
          // Mantiene la app activa mientras la pestaña esté abierta
          const PING_INTERVAL = 5 * 60 * 1000; // 5 minutos
          function keepAlive() {
            fetch('/weather-view')
              .then(r => console.log("Manteniendo vivo el servidor (Status: " + r.status + ")"))
              .catch(e => console.error("Fallo en keep-alive", e));
          }
          setInterval(keepAlive, PING_INTERVAL);
        </script>
      </body>
      </html>
    `);
  } catch (e) { res.status(502).send("Error al obtener datos"); }
});

// --- TAREA AUTOMÁTICA WINDGURU ---
setInterval(async () => {
  if (!WG_UID || !WG_PASSWORD) return;
  let d = weatherCache.get("weather_data");
  if (!d) return;
  try {
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    const params = new URLSearchParams({
      uid: WG_UID, salt, hash, interval: 120,
      wind_avg: kmhToKnots(d.windSpeed),
      wind_max: kmhToKnots(d.windGust),
      temperature: (d.temperature || '').replace(/[^0-9.-]/g, '')
    });
    await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
  } catch (e) { console.error("Error Windguru:", e.message); }
}, 120000);

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});

