import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- FUNCIONES DE UTILIDAD ---

function kmhToKnots(value) {
  if (!value) return null;
  const normalized = value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

// Extractor para la página principal (usa Clases CSS)
function extractByClass(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  return match && match[1] ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : null;
}

// Extractor para la UNLP (Busca el texto y captura el valor en la celda)
function extractByLabel(html, label) {
  // Esta regex busca la etiqueta (ej: Temperatura) y captura el valor azul que le sigue
  const regex = new RegExp(`${label}[^<]*<\\/font>[^<]*<font[^>]*>[^<]*<small>[^<]*<font[^>]*>([^<]+)`, 'i');
  const match = html.match(regex);
  if (!match) return null;
  // Limpiamos símbolos raros de la UNLP
  return match[1].replace(/&deg;|&#176;|°|C|/g, '').replace(/&nbsp;/g, ' ').trim();
}

function parseWeatherData(html, isBackup = false) {
  if (isBackup) {
    // Lógica específica para el HTML de la UNLP que me pasaste
    return {
      stationTime: "Sincronizado UNLP",
      temperature: extractByLabel(html, "Temperatura"),
      feelsLike: extractByLabel(html, "Sensacion Termica"),
      windSpeed: extractByLabel(html, "Velocidad"),
      windGust: extractByLabel(html, "Rafaga Mayor") || "0",
      windDir: extractByLabel(html, "Direccion") || "--",
      pressure: extractByLabel(html, "Presion"),
      humidity: extractByLabel(html, "Humedad"),
      rain: extractByLabel(html, "Diario"),
    };
  } else {
    // Lógica original para mooo.com
    let stationTime = extractByClass(html, 'lastupdate');
    if (!stationTime) {
      stationTime = new Date().toLocaleTimeString('es-AR', { 
          timeZone: 'America/Argentina/Buenos_Aires', 
          hour: '2-digit', minute: '2-digit', hour12: false 
      }) + " hs";
    }
    return {
      stationTime,
      temperature: extractByClass(html, 'outtemp'),
      feelsLike: (extractByClass(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
      windSpeed: extractByClass(html, 'curwindspeed'),
      windGust: extractByClass(html, 'curwindgust'),
      windDir: extractByClass(html, 'winddir') || extractByClass(html, 'curwinddir') || "--",
      pressure: extractByClass(html, 'barometer'),
      humidity: extractByClass(html, 'outHumidity'),
      rain: extractByClass(html, 'dayRain'),
    };
  }
}

// --- ENDPOINTS ---

app.get('/weather-view', async (req, res) => {
  let data = weatherCache.get("weather_data");
  if (data) return res.json(data);

  // Intento 1: Principal
  try {
    const response = await axios.get(SOURCE_URL, { timeout: 6000 });
    data = parseWeatherData(response.data, false);
    if (data.temperature) {
      weatherCache.set("weather_data", data);
      return res.json(data);
    }
  } catch (e) { console.log("Principal caída, intentando UNLP..."); }

  // Intento 2: UNLP (Backup)
  try {
    const response = await axios.get(BACKUP_URL, { timeout: 8000 });
    data = parseWeatherData(response.data, true);
    weatherCache.set("weather_data", data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Ambas estaciones fuera de línea" });
  }
});

app.get('/', async (req, res) => {
  // Reutilizamos la lógica del endpoint anterior
  try {
    const responseView = await axios.get(`http://localhost:${PORT}/weather-view`);
    const data = responseView.data;
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
          <p class="subtitle">Respaldo Automático EARG / UNLP</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature || '--'} °C</td></tr>
            <tr><td class="label">Sensación térmica</td><td class="value">${data.feelsLike || '--'} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots || '--'} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots || '--'} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDirection || '--'}</td></tr>
          </table>
          <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) { res.status(502).send("Error de conexión"); }
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

app.listen(PORT, () => { console.log("Servidor en puerto " + PORT); });
