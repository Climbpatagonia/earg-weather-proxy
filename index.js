import express from 'express';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SOURCE_URL = process.env.SOURCE_URL || 'http://earg_met.mooo.com:88/meteo/';

function extractValue(html, className) {
  const regex = new RegExp(`<[^>]*class=["']?${className}["']?[^>]*>\\s*([^<]+)`, 'i');
  const match = html.match(regex);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].replace(/&deg;|&#176;|°/g, '').trim();
}

function parseNumber(text) {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/,/g, '.').replace(new RegExp('[^0-9.\\-]+', 'g'), '').trim();
  return normalized.length ? Number(normalized) : null;
}

function parseWeatherData(html) {
  const outTemp = extractValue(html, 'outtemp');
  const feelsLikeText = extractValue(html, 'feelslike');
  const windSpeed = extractValue(html, 'curwindspeed');
  const windGust = extractValue(html, 'curwindgust');
  const windDir = extractValue(html, 'curwinddir');
  const windDeg = extractValue(html, 'curwinddeg');
  const barometer = extractValue(html, 'barometer');
  const dewPoint = extractValue(html, 'dewpoint');
  const humidity = extractValue(html, 'outHumidity');
  const rain = extractValue(html, 'dayRain');
  const rainRate = extractValue(html, 'rainRate');
  const uv = extractValue(html, 'uv-num') || extractValue(html, 'uvItem');

  return {
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    temperature: parseNumber(outTemp),
    feelsLike: parseNumber(feelsLikeText),
    windSpeed: parseNumber(windSpeed),
    windGust: parseNumber(windGust),
    windDirection: windDir ? windDir.trim() : null,
    windDirectionDegrees: parseNumber(windDeg),
    pressure: parseNumber(barometer),
    dewPoint: parseNumber(dewPoint),
    humidity: parseNumber(humidity),
    rain: parseNumber(rain),
    rainRate: parseNumber(rainRate),
    uvIndex: parseNumber(uv)
  };
}

app.get('/weather-view', async (req, res) => {
  try {
    const response = await fetch(SOURCE_URL, { method: 'GET' });
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch source', status: response.status });
    }

    const html = await response.text();
    const data = parseWeatherData(html);
    return res.json(data);
  } catch (error) {
    console.error('Fetch error:', error.message || error);
    return res.status(500).json({ error: 'Internal server error', message: error.message, updatedAt: new Date().toISOString() });
  }
});

app.get('/raw', async (req, res) => {
  try {
    const response = await fetch(SOURCE_URL, { method: 'GET' });
    if (!response.ok) {
      return res.status(502).send('Failed to fetch source page');
    }
    const html = await response.text();
    res.type('html').send(html);
  } catch (error) {
    console.error('Fetch error:', error.message || error);
    res.status(500).send('Proxy error');
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sourceUrl: SOURCE_URL, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Weather proxy running on port ${PORT}`);
  console.log(`Source URL: ${SOURCE_URL}`);
});
