import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/';
const NOAA_RAW_URL = 'https://tgftp.nws.noaa.gov/data/observations/metar/stations/SAWE.TXT';
const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- HORA LOCAL ARGENTINA ---
function getLocalTime() {
    return new Date().toLocaleTimeString("es-AR", {
        timeZone: "America/Argentina/Rio_Gallegos",
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }) + " hs";
}

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
        return { temp, wind, gust, dir };
    } catch (e) { return null; }
}

async function getWeatherData() {
    // 1. EARG
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 4500 });
        const html = r.data;
        if (html.includes('outtemp')) {
            return {
                stationTime: extractValue(html, 'lastupdate') !== "--" ? extractValue(html, 'lastupdate') : getLocalTime(),
                temperature: extractValue(html, 'outtemp'),
                feelsLike: (extractValue(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim() || "--",
                windSpeed: extractValue(html, 'curwindspeed'),
                windGust: extractValue(html, 'curwindgust'),
                windDir: extractValue(html, 'winddir') || extractValue(html, 'curwinddir') || "--",
                pressure: extractValue(html, 'barometer'),
                source: "EARG (Principal)"
            };
        }
    } catch (e) {}

    // 2. NOAA Backup
    try {
        const r = await axios.get(NOAA_RAW_URL, { timeout: 4000 });
        const decoded = decodeMetar(r.data.split('\n')[1]);
        if (decoded) {
            return {
                stationTime: getLocalTime() + " (SAWE)",
                temperature: decoded.temp,
                feelsLike: decoded.temp,
                windSpeed: decoded.wind,
                windGust: decoded.gust,
                windDir: decoded.dir,
                pressure: "--",
                source: "SAWE (Aeropuerto)"
            };
        }
    } catch (e) {}

    return weatherCache.get("last_valid") || null;
}

// --- ENDPOINTS ---

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    if (!data) return res.status(502).json({ error: "offline" });

    weatherCache.set("last_valid", data);

    // JSON ESTRICTO PARA EL RELOJ
    // Forzamos a que todo sea String para evitar errores de parseo en Monkey C
    res.json({
        "temperature": data.temperature.toString(),
        "feelsLike": data.feelsLike.toString(),
        "windSpeed": data.windSpeed.toString(),
        "windGust": data.windGust.toString(),
        "windDirection": data.windDir.toString(),
        "stationTime": data.stationTime.toString()
    });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData() || weatherCache.get("last_valid");
    if (!data) return res.status(502).send("Error de conexión");

    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);

    res.send(`
      <body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;display:flex;justify-content:center;padding:2rem;">
        <div style="background:#1e293b;padding:2rem;border-radius:1rem;border:1px solid #334155;max-width:350px;width:100%;">
          <h1 style="color:#7dd3fc;font-size:1.2rem;text-align:center;">Estación Río Grande</h1>
          <p style="text-align:center;color:#94a3b8;font-size:0.8rem;">${data.source}</p>
          <hr style="border:0;border-top:1px solid #334155;margin:1rem 0;">
          <div style="display:flex;justify-content:space-between;margin:0.5rem 0;"><span>Viento:</span><b>${knots} kn</b></div>
          <div style="display:flex;justify-content:space-between;margin:0.5rem 0;"><span>Ráfaga:</span><b>${gustKnots} kn</b></div>
          <div style="display:flex;justify-content:space-between;margin:0.5rem 0;"><span>Temp:</span><b>${data.temperature} °C</b></div>
          <div style="display:flex;justify-content:space-between;margin:0.5rem 0;"><span>Presión:</span><b>${data.pressure} hPa</b></div>
          <p style="text-align:center;color:#6366f1;font-size:0.8rem;margin-top:1.5rem;">🕒 ${data.stationTime}</p>
        </div>
      </body>
    `);
});

// --- WINDGURU ---
setInterval(async () => {
    if (!WG_UID || !WG_PASSWORD) return;
    const d = weatherCache.get("last_valid");
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

app.listen(PORT, () => console.log("Servidor en puerto " + PORT));
