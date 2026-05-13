import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

// Configuración de puertos y URLs
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PRIMARY_SOURCE = 'http://earg_met.mooo.com:88/meteo/'; 
const BACKUP_SOURCE = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- FUNCIONES DE UTILIDAD ---

function extractValue(html, className) {
  // Intenta buscar por clase (Estación principal)
  const regexClass = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  let match = html.match(regexClass);
  
  if (!match) {
    // Si falla, intenta buscar por ID (formato de algunas tablas de UNLP)
    const regexId = new RegExp(`<[^>]*id=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    match = html.match(regexId);
  }

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

async function getWeatherData() {
  let cached = weatherCache.get("weather_data");
  if (cached) return cached;

  // Intento 1: Estación Principal
  try {
    console.log("📡 Consultando estación principal (mooo.com)...");
    const response = await axios.get(PRIMARY_SOURCE, { timeout: 8000 });
    const data = parseWeatherData(response.data);
    if (!data.temperature) throw new Error("Datos incompletos en Principal");
    weatherCache.set("weather_data", data);
    return data;
  } catch (e) {
    console.warn("⚠️ Principal falló o sin datos, intentando respaldo UNLP (Tabla)...");
    
    // Intento 2: Estación de Respaldo (La nueva URL con tablas)
    try {
      const response = await axios.get(BACKUP_SOURCE, { timeout: 10000 });
      const data = parseWeatherData(response.data);
      weatherCache.set("weather_data", data);
      console.log("✅ Datos obtenidos de UNLP Tabla");
      return data;
    } catch (e2) {
      console.error("❌ Fallo total de estaciones");
      return null;
    }
  }
}

// --- ENDPOINTS ---

app.get('/weather-view', async (req, res) => {
  const data = await getWeatherData();
  if (!data) return res.status(502).json({ error: "Estaciones offline" });

  res.json({
    "temperature": data.temperature,
    "feelsLike": data.feelsLike,
    "windSpeed": data.windSpeed,
    "windGust": data.windGust,
    "windDirection": data.windDir,
    "stationTime": data.stationTime
  });
});

app.get('/', async (req, res) => {
  const data = await getWeatherData();
  if (!data) return res.status(502).send("Error: Estaciones no disponibles.");

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
        .subtitle { font-size: 0.85rem; color: #94a3b8; text-align: center; margin-bottom: 0.5rem; padding-bottom: 1rem; border-bottom: 1px solid #334155; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        td { padding: 10px 8px; border-bottom: 1px solid #334155; }
        .label { color: #94a3b8; }
        .value { text-align: right; font-weight: 700; color: #f1f5f9; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Estación Río Grande</h1>
        <p class="subtitle">Sincronización Dual (Principal / UNLP)</p>
        <table>
          <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
          <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
          <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
          <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
          <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'} %</td></tr>
        </table>
        <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
      </div>
    </body>
    </html>
  `);
});

setInterval(async () => {
  if (!WG_UID || !WG_PASSWORD) return;
  const d = await getWeatherData();
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
  console.log("🚀 Servidor en puerto " + PORT);
});
