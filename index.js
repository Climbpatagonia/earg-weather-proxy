import express from 'express';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = process.env.SOURCE_URL || 'http://earg_met.mooo.com:88/meteo/';

const COMPASS_POINTS = [
  'N','NNE','NE','ENE','E','ESE','SE','SSE',
  'S','SSO','SO','OSO','O','ONO','NO','NNO',
];

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

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EARG — Sin datos</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 2rem;
    }
    .card {
      background: #1e293b; border-radius: 1rem;
      padding: 2rem 2.5rem; max-width: 480px; width: 100%; text-align: center;
    }
    h1 { font-size: 1.1rem; color: #7dd3fc; margin-bottom: 0.75rem; }
    p  { color: #94a3b8; font-size: 1rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Estación Astronómica Río Grande</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

app.get('/', (_req, res) => res.redirect('/weather-view'));

app.get('/weather', async (req, res) => {
  try {
    const response = await fetch(SOURCE_URL, { method: 'GET' });
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch source', status: response.status });
    }
    const data = parseWeatherData(await response.text());
    return res.type('json').send(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Fetch error:', error.message || error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/weather-view', async (req, res) => {
  try {
    const response = await fetch(SOURCE_URL, { method: 'GET' });
    if (!response.ok) {
      return res.status(502).type('html').send(
        errorPage('La estación meteorológica no está disponible en este momento. Intentá de nuevo en unos minutos.')
      );
    }

    const d = parseWeatherData(await response.text());

    const rows = [
      ['Temperatura',      d.temperature  ? `${d.temperature} °C`  : '—'],
      ['Sensación térmica', d.feelsLike   ? `${d.feelsLike} °C`    : '—'],
      ['Viento',           kmhToKnots(d.windSpeed) ? `${kmhToKnots(d.windSpeed)} kn` : '—'],
      ['Ráfaga',           kmhToKnots(d.windGust)  ? `${kmhToKnots(d.windGust)} kn`  : '—'],
      ['Dirección',        d.windDirectionDegrees                   ?? '—'],
      ['Presión',          d.pressure                               ?? '—'],
      ['Punto de rocío',   d.dewPoint                               ?? '—'],
      ['Humedad',          d.humidity                               ?? '—'],
      ['Lluvia del día',   d.rain                                   ?? '—'],
      ['Tasa de lluvia',   d.rainRate                               ?? '—'],
      ['Índice UV',        d.uvIndex                                ?? '—'],
    ];

    const tableRows = rows.map(([label, value]) => `
      <tr>
        <td class="label">${label}</td>
        <td class="value">${value}</td>
      </tr>`).join('');

    const updatedAt = new Date(d.updatedAt).toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Ushuaia',
      hour12: false,
    });

    return res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EARG — Tiempo en Río Grande</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      display: flex; justify-content: center; align-items: flex-start;
      min-height: 100vh; padding: 2.5rem 1rem;
    }
    .card {
      background: #1e293b; border-radius: 1rem;
      padding: 2rem 2.5rem; max-width: 480px; width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.3rem; font-weight: 700; letter-spacing: 0.04em; color: #7dd3fc; margin-bottom: 0.25rem; }
    .subtitle { font-size: 0.85rem; color: #64748b; margin-bottom: 1.75rem; }
    table { width: 100%; border-collapse: collapse; }
    tr { border-bottom: 1px solid #334155; }
    tr:last-child { border-bottom: none; }
    td { padding: 0.75rem 0.25rem; font-size: 1.05rem; line-height: 1.5; }
    td.label { color: #94a3b8; width: 55%; }
    td.value { color: #f1f5f9; font-weight: 600; text-align: right; }
    .updated { margin-top: 1.5rem; font-size: 0.78rem; color: #475569; text-align: right; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Estación Astronómica Río Grande</h1>
    <p class="subtitle">Datos meteorológicos en tiempo real</p>
    <table>${tableRows}
    </table>
    <p class="updated">Actualizado: ${updatedAt}</p>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('Fetch error:', error.message || error);
    return res.status(500).type('html').send(
      errorPage('No se pudo conectar con la estación meteorológica. La fuente de datos puede estar temporalmente fuera de línea.')
    );
  }
});

app.get('/raw', async (_req, res) => {
  try {
    const response = await fetch(SOURCE_URL, { method: 'GET' });
    if (!response.ok) return res.status(502).send('Failed to fetch source page');
    res.type('html').send(await response.text());
  } catch (error) {
    console.error('Fetch error:', error.message || error);
    res.status(500).send('Proxy error');
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sourceUrl: SOURCE_URL, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Weather proxy running on port ${PORT}`);
  console.log(`Source URL: ${SOURCE_URL}`);
});

