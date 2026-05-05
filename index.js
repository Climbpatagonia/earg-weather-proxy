import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

// Configuración de entorno
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

// CACHÉ DE 5 MINUTOS (Sincronizado con la EARG)
const weatherCache = new NodeCache({ stdTTL: 300 });

// ─── FUNCIONES DE APOYO ──────────────────────────────────────────────────

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
  if (!stationTime || stationTime.length < 3) {
    stationTime = new Date().toLocaleTimeString('es-AR', { 
      timeZone: 'America/Argentina/Buenos_Aires', 
      hour: '2-digit', minute: '2-digit', hour12: false 
    }) + " hs (Proxy)";
  }
  return {
    stationTime,
    temperature: extractValue(html, 'outtemp'),
    feelsLike: (extractValue(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
    windSpeed: extractValue(html, 'curwindspeed'),
    windGust: extractValue(html, 'curwindgust'),
    windDir: extractValue(html, 'curwinddir'),
    pressure: extractValue(html, 'barometer'),
    humidity: extractValue(html, 'outHumidity'),
    rain: extractValue(html, 'dayRain'),
  };
}

// FUNCIÓN DE SUBIDA A WINDGURU
async function syncWithWindguru() {
  if (!WG_UID || !WG_PASSWORD) return;
  
  try {
    // Intentamos sacar el dato del caché primero
    let d = weatherCache.get("weather_data");
    
    // Si el caché está vacío, hacemos una petición rápida a la fuente
    if (!d) {
      const response = await axios.get(SOURCE_URL, { timeout: 8000 });
      d = parseWeatherData(response.data);
      weatherCache.set("weather_data", d);
    }

    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    
    const params = new URLSearchParams({
      uid: WG_UID, 
      salt, 
      hash, 
      interval: 120, // Reportamos intervalo de 2 min
      wind_avg: kmhToKnots(d.windSpeed),
      wind_max: kmhToKnots(d.windGust),
      temperature: (d.temperature || '').replace(/[^0-9.-]/g, ''),
      rh: (d.humidity || '').replace(/[^0-9.-]/g, '')
    });

    await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
    console.log(`[${new Date().toLocaleTimeString()}] Windguru: Datos enviados (Cada 2 min).`);
  } catch (err) {
    console.error('[Windguru] Fallo en el envío.');
  }
}

// ─── RUTAS ──────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  const cacheKey = "weather_data";
  let data = weatherCache.get(cacheKey);

  try {
    if (!data) {
      const response = await axios.get(SOURCE_URL, { timeout: 10000 });
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
        <meta http-equiv="refresh" content="300">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EARG - Clima</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 2rem 1rem; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1.2rem; width: 100%; max-width: 400px; box-shadow: 0 20px 25px rgba(0,0,0,0.3); border: 1px solid #334155; }
          h1 { color: #7dd3fc; font-size: 1.3rem; margin: 0 0 0.5rem 0; text-align: center; }
          .subtitle { font-size: 0.85rem; color: #94a3b8; text-align: center; margin-bottom: 2rem; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 14px 8px; border-bottom: 1px solid #334155; }
          .label { color: #94a3b8; }
          .value { text-align: right; font-weight: 700; color: #f8fafc; }
          .updated { font-size: 0.8rem; color: #818cf8; margin-top: 2rem; text-align: center; background: #1e1b4b; padding: 12px; border-radius: 8px; border: 1px solid #312e81; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estación Río Grande</h1>
          <p class="subtitle">Proxy EARG - Windguru activo</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir || '--'}</td></tr>
            <tr><td class="label">Humedad</td><td class="value">${data.humidity || '--'} %</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure || '--'} hPa</td></tr>
          </table>
          <div class="updated">🕒 Lectura Estación: ${data.stationTime}</div>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(502).send("<div style='color:white;text-align:center;'>Error en conexión con la estación.</div>");
  }
});

// DISPARO AUTOMÁTICO PARA WINDGURU (CADA 2 MINUTOS)
setInterval(syncWithWindguru, 120000);

app.listen(PORT, () => console.log(`Sincronización dual activa en puerto ${PORT}`));
