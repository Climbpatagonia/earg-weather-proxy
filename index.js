import express from 'express';
import axios from 'axios';
import cors from 'cors';
import NodeCache from 'node-cache';
import md5 from 'md5';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const PRIMARY_URL = 'http://earg_met.mooo.com:88/meteo/';
const BACKUP_URL = 'http://earg.fcaglp.unlp.edu.ar/meteorologia/vp2s1/vantalhb.htm';

const WG_UID = process.env.WG_UID;
const WG_PASSWORD = process.env.WG_PASSWORD;

const weatherCache = new NodeCache({ stdTTL: 300 });

// --- UTILIDADES DE LIMPIEZA ---

function cleanValue(text) {
  if (!text) return "";
  // Extrae solo números, puntos o el signo menos (elimina C, km/h, etc)
  const match = text.match(/[-+]?[0-9]*[.,]?[0-9]+/);
  return match ? match[0].replace(',', '.') : "";
}

function toKnots(val) {
  const n = parseFloat(cleanValue(val));
  return isNaN(n) ? "--" : (n * 0.539957).toFixed(1);
}

// --- BUSCADOR QUIRÚRGICO PARA EL HTML DE UNLP ---

function scrapeData(html, label) {
  // Busca la palabra clave (ej: "Temperatura") y captura el valor azul que le sigue
  const regex = new RegExp(`${label}[^<]*<\\/font>[^<]*<font[^>]*>[^<]*<small>[^<]*<font[^>]*>([^<]+)`, 'i');
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

async function getMeteo() {
  const cached = weatherCache.get("current");
  if (cached) return cached;

  // Intentamos siempre primero la principal (tu mooo.com)
  try {
    const r = await axios.get(PRIMARY_URL, { timeout: 8000 });
    // Aquí podrías usar tu lógica vieja de clases si mooo.com usa clases
    // Por ahora, si falla, saltamos al respaldo que ya conocemos bien:
  } catch (e) {}

  try {
    const r = await axios.get(BACKUP_URL, { timeout: 10000 });
    const h = r.data;
    
    const d = {
      temp: cleanValue(scrapeData(h, "Temperatura")),
      st: cleanValue(scrapeData(h, "Sensacion Termica")),
      hum: cleanValue(scrapeData(h, "Humedad")),
      press: cleanValue(scrapeData(h, "Presion")),
      wind: cleanValue(scrapeData(h, "Velocidad")),
      gust: cleanValue(scrapeData(h, "Rafaga Mayor")),
      dir: scrapeData(h, "Direccion"), // SSW, etc.
      rain: cleanValue(scrapeData(h, "Diario")),
      time: "Sincronizado UNLP"
    };

    if (d.temp) {
      weatherCache.set("current", d);
      return d;
    }
  } catch (e) { return null; }
  return null;
}

// --- RUTAS ---

app.get('/weather-view', async (req, res) => {
  const d = await getMeteo();
  if (!d) return res.status(502).json({ error: "offline" });
  res.json({
    temp: d.temp,
    st: d.st || d.temp,
    windKnots: toKnots(d.wind),
    gustKnots: toKnots(d.gust),
    direction: d.dir,
    time: d.time
  });
});

app.get('/', async (req, res) => {
  const d = await getMeteo();
  if (!d) return res.status(502).send("Sin conexión a las estaciones.");

  res.send(`
    <body style="background:#0f172a; color:white; font-family:sans-serif; display:flex; justify-content:center; padding:20px;">
      <div style="background:#1e293b; padding:25px; border-radius:15px; width:300px; border:1px solid #334155;">
        <h2 style="color:#38bdf8; text-align:center; margin:0 0 20px 0;">Río Grande</h2>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Temperatura</span><b>${d.temp} °C</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Sensación</span><b>${d.st} °C</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Viento</span><b>${toKnots(d.wind)} kn</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Ráfaga</span><b>${toKnots(d.gust)} kn</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Dirección</span><b>${d.dir}</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #334155;">
          <span>Presión</span><b>${d.press} hPa</b>
        </div>
        <div style="display:flex; justify-content:space-between; padding:8px 0;">
          <span>Lluvia</span><b>${d.rain} mm</b>
        </div>
        <p style="text-align:center; font-size:0.7rem; color:#6366f1; margin-top:20px;">${d.time}</p>
      </div>
    </body>
  `);
});

// --- TAREA WINDGURU ---
setInterval(async () => {
  if (!WG_UID) return;
  const d = await getMeteo();
  if (!d) return;
  try {
    const salt = Date.now().toString();
    const hash = md5(salt + WG_UID + WG_PASSWORD);
    await axios.get('http://www.windguru.cz/upload/api.php', {
      params: {
        uid: WG_UID, salt, hash, interval: 120,
        wind_avg: toKnots(d.wind), wind_max: toKnots(d.gust), temperature: d.temp
      }
    });
  } catch (e) {}
}, 120000);

app.listen(PORT);
