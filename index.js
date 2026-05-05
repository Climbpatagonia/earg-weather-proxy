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

const COMPASS_POINTS = [
  'N','NNE','NE','ENE','E','ESE','SE','SSE',
  'S','SSO','SO','OSO','O','ONO','NO','NNO',
];

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

function degreesToCompass(value) {
  if (!value) return null;
  const normalized = value.replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  if (!normalized.length) return null;
  const deg = ((parseFloat(normalized) % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

function parseWeatherData(html) {
  const outTemp    = extractValue(html, 'outtemp');
  const feelsLike  = extractValue(html, 'feelslike');
  const windSpeed  = extractValue(html, 'curwindspeed');
  const windGust   = extractValue(html, 'curwindgust');
  const windDir    = extractValue(html, 'curwinddir');
  const windDeg    = extractValue(html, 'curwinddeg');
  const barometer  = extractValue(html, 'barometer');
  const dewPoint   = extractValue(html, 'dewpoint');
  const humidity   = extractValue(html, 'outHumidity');
  const rain       = extractValue(html, 'dayRain');
  const rainRate   = extractValue(html, 'rainRate');
  const uv         = extractValue(html, 'uv-num') || extractValue(html, 'uvItem');

  return {
    sourceUrl:            SOURCE_URL,
    updatedAt:            new Date().toISOString(),
    temperature:          outTemp   ? outTemp.replace('°C', '').trim() : null,
    feelsLike:            feelsLike ? feelsLike.replace(/^ST:\s*/i, '').trim() : null,
    windSpeed:            windSpeed ? windSpeed.trim() : null,
    windGust:             windGust  ? windGust.trim()  : null,
    windDirection:        windDir   ? windDir.trim() : null,
    windDirectionDegrees: degreesToCompass(windDeg),
    pressure:             barometer ? barometer.trim() : null,
    dewPoint:             dewPoint  ? dewPoint.trim() : null,
    humidity:             humidity  ? humidity.trim() : null,
    rain:                 rain      ? rain.trim() : null,
    rainRate:             rainRate  ? rainRate.trim() : null,
    uvIndex:              uv        ? uv.trim() : null,
  };
}

// ─── RUTAS EXPRESS CON CACHÉ ──────────────────────────────────────────────────

app.get('/', (_req, res) => res.send('Proxy EARG activo con Caché (3 min).'));

app.get('/weather', async (req, res) => {
  const cacheKey = "weather_json";
  const cachedData = weatherCache.get(cacheKey);

  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const response = await axios.get(SOURCE_URL, { timeout: 8000 });
    const data = parseWeatherData(response.data);
    weatherCache.set(cacheKey, data);
    return res.json(data);
  } catch (error) {
    console.error('Error fetching weather:', error.message);
    const lastKnown = weatherCache.get(cacheKey);
    return res.status(502).json(lastKnown || { error: 'Fuente no disponible' });
  }
});

// ─── WINDGURU UPLOAD (Cada 60 seg) ───────────────────────────────────────────

function toFloat(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function directionToDegrees(dir) {
  const map = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSO: 202.5, SO: 225, OSO: 247.5, O: 270, ONO: 292.5, NO: 315, NNO: 337.5
  };
  return map[dir?.toUpperCase()] ?? null;
}

async function uploadToWindguru() {
  if (!WG_UID || !WG_PASSWORD) return;
  try {
    const response = await axios.get(SOURCE_URL);
    const d = parseWeatherData(response.data);
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);

    const params = new URLSearchParams({
      uid: WG_UID, salt, hash, interval: 60,
      wind_avg: toFloat(kmhToKnots(d.windSpeed)),
      wind_max: toFloat(kmhToKnots(d.windGust)),
      wind_direction: directionToDegrees(d.windDirection),
      temperature: toFloat(d.temperature),
      rh: toFloat(d.humidity),
      mslp: toFloat(d.pressure)
    });

    const resp = await axios.get(`http://www.windguru.cz/upload/api.php?${params.toString()}`);
    console.log(`[Windguru] Update: ${resp.data}`);
  } catch (err) {
    console.error('[Windguru] Error:', err.message);
  }
}

setInterval(uploadToWindguru, 60 * 1000);

// ─── INICIO ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}. Fuente: ${SOURCE_URL}`);
});
