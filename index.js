import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = 'http://earg_met.mooo.com:88/meteo/'; 
const weatherCache = new NodeCache({ stdTTL: 300 });

function extractValue(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  return match ? match[1].replace(/&deg;|&#176;|°/g, '').trim() : "--";
}

function kmhToKnots(value) {
  if (!value) return null;
  const normalized = value.replace(/,/g, '.').replace(/[^0-9.\-]/g, '').trim();
  return normalized.length ? (parseFloat(normalized) * 0.539957).toFixed(1) : null;
}

app.get('/weather', async (req, res) => {
  try {
    const response = await axios.get(SOURCE_URL, { timeout: 8000 });
    const html = response.data;

    const data = {
      temperature: extractValue(html, 'outtemp'),
      feelsLike: extractValue(html, 'feelslike').replace(/^ST:\s*/i, '').trim(),
      windSpeed: extractValue(html, 'curwindspeed'),
      windGust: extractValue(html, 'curwindgust'),
      windDir: extractValue(html, 'winddir'), // <--- AQUÍ TOMAMOS LAS LETRAS
      pressure: extractValue(html, 'barometer'),
      humidity: extractValue(html, 'outHumidity'),
      rain: extractValue(html, 'dayRain'),
      stationTime: extractValue(html, 'lastupdate')
    };

    // REDUNDANCIA: Enviamos la dirección con los 3 nombres más comunes en Garmin
    res.json({
      ...data,
      windDirection: data.windDir,
      wind_dir: data.windDir
    });
  } catch (e) {
    res.status(502).json({ error: "Error de conexión con la estación" });
  }
});

// La vista HTML se mantiene igual para control visual tuyo
app.get('/', async (req, res) => {
  // ... (mismo código de la tabla que ya tienes)
});

app.listen(PORT);
