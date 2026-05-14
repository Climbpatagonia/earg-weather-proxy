import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
const NOAA_RAW_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/stations/SAWE.TXT';
const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- UTILIDADES ---
function extractValue(html, className) {
    const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    const match = html.match(regex);
    if (!match || !match[1]) return "--";
    return match[1].replace(/&deg;|&#176;|°/g, '').trim();
}

function kmhToKnots(value) {
    if (!value || value === "--") return "--";
    const normalized = value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
    return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : "--";
}

function decodeMetar(metar) {
    try {
        const tempMatch = metar.match(/(?:\s|)(M?\d{2})\/(M?\d{2})(?:\s|)/);
        let temp = "--";
        if (tempMatch) {
            temp = tempMatch[1].replace('M', '-');
            temp = parseInt(temp).toString();
        }
        const windMatch = metar.match(/(\d{3})(\d{2})(?:G(\d{2}))?KT/);
        let wind = "0", gust = "0", dir = "--";
        if (windMatch) {
            dir = windMatch[1] + "°";
            wind = (parseInt(windMatch[2]) * 1.852).toFixed(1);
            if (windMatch[3]) gust = (parseInt(windMatch[3]) * 1.852).toFixed(1);
        }
        return { temp, wind, gust, dir, source: "SAWE (Aeropuerto)" };
    } catch (e) { return null; }
}

async function getWeatherData() {
    // 1. Intento EARG
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 5000 });
        const html = r.data;
        if (html.includes('outtemp')) {
            return {
                stationTime: extractValue(html, 'lastupdate'),
                temperature: extractValue(html, 'outtemp'),
                feelsLike: (extractValue(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim() || "--",
                windSpeed: extractValue(html, 'curwindspeed'),
                windGust: extractValue(html, 'curwindgust'),
                windDir: extractValue(html, 'winddir') || extractValue(html, 'curwinddir') || "--",
                pressure: extractValue(html, 'barometer'),
                humidity: extractValue(html, 'outHumidity'),
                source: "EARG (Principal)"
            };
        }
    } catch (e) {}

    // 2. Backup NOAA
    try {
        const r = await axios.get(NOAA_RAW_URL, { timeout: 4000 });
        const decoded = decodeMetar(r.data.split('\n')[1]);
        if (decoded) {
            return {
                stationTime: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + " (SAWE)",
                temperature: decoded.temp,
                feelsLike: decoded.temp,
                windSpeed: decoded.wind,
                windGust: decoded.gust,
                windDir: decoded.dir,
                pressure: "--",
                humidity: "--",
                source: decoded.source
            };
        }
    } catch (e) {}

    return weatherCache.get("weather_data") || null;
}

// --- ENDPOINTS ---

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    if (!data) return res.status(502).json({ error: "offline" });

    weatherCache.set("weather_data", data);

    // ESTRUCTURA EXACTA DEL RELOJ QUE FUNCIONABA
    res.json({
        "temperature": data.temperature,
        "feelsLike": data.feelsLike,
        "windSpeed": data.windSpeed,
        "windGust": data.windGust,
        "windDirection": data.windDir, // AQUÍ ESTABA EL ERROR (Era windDirection)
        "stationTime": data.stationTime
    });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData();
    if (!data) return res.status(502).send("Error de conexión");

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
          <p class="subtitle">Fuente: ${data.source}</p>
          <table>
            <tr><td class="label">Temperatura</td><td class="value">${data.temperature} °C</td></tr>
            <tr><td class="label">Sensación</td><td class="value">${data.feelsLike} °C</td></tr>
            <tr><td class="label">Viento</td><td class="value">${knots} kn</td></tr>
            <tr><td class="label">Ráfaga</td><td class="value">${gustKnots} kn</td></tr>
            <tr><td class="label">Dirección</td><td class="value">${data.windDir}</td></tr>
            <tr><td class="label">Presión</td><td class="value">${data.pressure} hPa</td></tr>
          </table>
          <p style="text-align:center; font-size:0.8rem; color:#6366f1; margin-top:20px;">🕒 ${data.stationTime}</p>
        </div>
      </body>
      </html>
    `);
});

// --- WINDGURU ---
setInterval(async () => {
    if (!WG_UID || !WG_PASSWORD) return;
    const d = weatherCache.get("weather_data");
    if (!d) return;
    try {
        const salt = Date.now().toString();
        const hash = md5(salt + WG_UID + WG_PASSWORD);
        const wAvg = kmhToKnots(d.windSpeed);
        const wMax = kmhToKnots(d.windGust);
        const t = (d.temperature || '').toString().replace(/[^0-9.-]/g, '');
        const url = "http://www.windguru.cz/upload/api.php?uid=" + WG_UID + "&salt=" + salt + "&hash=" + hash + "&wind_avg=" + wAvg + "&wind_max=" + wMax + "&temperature=" + t;
        await axios.get(url);
    } catch (e) {}
}, 120000);

app.listen(PORT, () => console.log("Servidor OK en puerto " + PORT));
