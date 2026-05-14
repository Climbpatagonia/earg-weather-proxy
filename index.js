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

const weatherCache = new NodeCache({ stdTTL: 600 });

function getLocalTime() {
    return new Date().toLocaleString("es-AR", {
        timeZone: "America/Argentina/Rio_Gallegos",
        hour: '2-digit', minute: '2-digit'
    }) + " hs";
}

function kmhToKnots(value) {
    if (!value || value === "--") return null;
    const normalized = value.toString().replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
    return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

function extractByClass(html, className) {
    const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
    const match = html.match(regex);
    return match ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : null;
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
    try {
        const r = await axios.get(SOURCE_URL, { timeout: 4500 });
        const html = r.data;
        if (html.includes('outtemp')) {
            return {
                stationTime: extractByClass(html, 'lastupdate') || getLocalTime(),
                temperature: extractByClass(html, 'outtemp'),
                feelsLike: (extractByClass(html, 'feelslike') || '').replace(/^ST:\s*/i, '').trim(),
                windSpeed: extractByClass(html, 'curwindspeed'),
                windGust: extractByClass(html, 'curwindgust'),
                windDir: extractByClass(html, 'winddir') || extractByClass(html, 'curwinddir') || "--",
                pressure: extractByClass(html, 'barometer'),
                humidity: extractByClass(html, 'outHumidity'),
                rain: extractByClass(html, 'dayRain'),
                source: "EARG (Principal)"
            };
        }
    } catch (e) {}

    try {
        const r = await axios.get(NOAA_RAW_URL, { timeout: 4000 });
        const lines = r.data.split('\n');
        const decoded = decodeMetar(lines[1]);
        if (decoded) {
            return {
                stationTime: getLocalTime() + " (SAWE)",
                temperature: decoded.temp,
                feelsLike: decoded.temp,
                windSpeed: decoded.wind,
                windGust: decoded.gust,
                windDir: decoded.dir,
                pressure: "--",
                humidity: "--",
                rain: "0.0",
                source: "SAWE (Aeropuerto)"
            };
        }
    } catch (e) {}
    return null;
}

app.get('/weather-view', async (req, res) => {
    const data = await getWeatherData();
    const last = weatherCache.get("last_valid");
    const current = data || last;

    if (current) {
        if (data) weatherCache.set("last_valid", data);
        return res.json({
            temp: parseFloat(current.temperature) || 0,
            feels: parseFloat(current.feelsLike) || 0,
            wind: parseFloat(kmhToKnots(current.windSpeed)) || 0,
            gust: parseFloat(kmhToKnots(current.windGust) || kmhToKnots(current.windSpeed)) || 0,
            dir: current.windDir ? current.windDir.toString() : "--",
            pres: parseFloat(current.pressure) || 0,
            hum: parseInt(current.humidity) || 0,
            time: current.stationTime.split(' ')[0]
        });
    }
    res.status(502).json({ error: "Offline" });
});

app.get('/', async (req, res) => {
    const data = await getWeatherData() || weatherCache.get("last_valid");
    if (!data) return res.status(502).send("Error de conexión");
    const knots = kmhToKnots(data.windSpeed);
    const gustKnots = kmhToKnots(data.windGust);
    res.send(`
      <body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;display:flex;justify-content:center;padding:2rem;">
        <div style="background:#1e293b;padding:2rem;border-radius:1rem;border:1px solid #334155;text-align:center;">
          <h1 style="color:#7dd3fc;font-size:1.2rem;">${data.source}</h1>
          <p style="font-size:2rem;margin:10px 0;">${knots || '--'} kn</p>
          <p style="color:#94a3b8;">Temp: ${data.temperature}°C | Hum: ${data.humidity}%</p>
          <p style="color:#6366f1;font-size:0.8rem;margin-top:15px;">🕒 ${data.stationTime}</p>
        </div>
      </body>
    `);
});

setInterval(async () => {
    if (!WG_UID || !WG_PASSWORD) return;
    const d = weatherCache.get("last_valid");
    if (!d) return;
    try {
        const salt = Date.now().toString();
        const hash = md5(salt + WG_UID + WG_PASSWORD);
        const wAvg = kmhToKnots(d.windSpeed) || 0;
        const wMax = kmhToKnots(d.windGust) || 0;
        const t = (d.temperature || '').toString().replace(/[^0-9.-]/g, '');
        const url = "http://www.windguru.cz/upload/api.php?uid=" + WG_UID + "&salt=" + salt + "&hash=" + hash + "&wind_avg=" + wAvg + "&wind_max=" + wMax + "&temperature=" + t;
        await axios.get(url);
    } catch (e) {}
}, 120000);

app.listen(PORT, () => console.log("Servidor en puerto " + PORT));
