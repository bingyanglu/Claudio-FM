const DEFAULT_WEATHER_CACHE_MS = 10 * 60 * 1000;

const WEATHER_CODES = new Map([
  [0, 'Clear'],
  [1, 'Mostly clear'],
  [2, 'Partly cloudy'],
  [3, 'Cloudy'],
  [45, 'Fog'],
  [48, 'Rime fog'],
  [51, 'Light drizzle'],
  [53, 'Drizzle'],
  [55, 'Dense drizzle'],
  [56, 'Freezing drizzle'],
  [57, 'Freezing drizzle'],
  [61, 'Light rain'],
  [63, 'Rain'],
  [65, 'Heavy rain'],
  [66, 'Freezing rain'],
  [67, 'Freezing rain'],
  [71, 'Light snow'],
  [73, 'Snow'],
  [75, 'Heavy snow'],
  [77, 'Snow grains'],
  [80, 'Rain showers'],
  [81, 'Rain showers'],
  [82, 'Heavy rain showers'],
  [85, 'Snow showers'],
  [86, 'Heavy snow showers'],
  [95, 'Thunderstorm'],
  [96, 'Thunderstorm with hail'],
  [99, 'Thunderstorm with hail'],
]);

const environment = {
  timeZone: validTimeZone(process.env.CLAUDIO_TIME_ZONE) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC',
  locale: process.env.CLAUDIO_LOCALE || 'en-US',
  locationLabel: process.env.CLAUDIO_LOCATION_LABEL || '',
  latitude: numberEnv('CLAUDIO_LATITUDE'),
  longitude: numberEnv('CLAUDIO_LONGITUDE'),
  weather: null,
  weatherUpdatedAt: 0,
  weatherError: '',
};

function numberEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : null;
}

function validTimeZone(value) {
  if (!value) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return '';
  }
}

function formatDateParts(date = new Date(), timeZone = environment.timeZone, locale = environment.locale) {
  const parts = new Intl.DateTimeFormat(locale || 'en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return {
    weekday: get('weekday'),
    month: get('month'),
    day: get('day'),
    year: get('year'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function currentTimeContext(date = new Date()) {
  const parts = formatDateParts(date);
  return {
    timeZone: environment.timeZone,
    locale: environment.locale,
    iso: date.toISOString(),
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
  };
}

function updateEnvironment(input = {}) {
  const timeZone = validTimeZone(input.timeZone);
  if (timeZone) environment.timeZone = timeZone;
  if (typeof input.locale === 'string' && input.locale.trim()) {
    environment.locale = input.locale.trim();
  }
  if (typeof input.locationLabel === 'string') {
    environment.locationLabel = input.locationLabel.trim().slice(0, 120);
  }
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    if (lat !== environment.latitude || lon !== environment.longitude) {
      environment.weather = null;
      environment.weatherUpdatedAt = 0;
    }
    environment.latitude = lat;
    environment.longitude = lon;
  }
}

function weatherText(weather = environment.weather) {
  if (!weather) return '';
  const temp = Number.isFinite(weather.temperature) ? `${Math.round(weather.temperature)}${weather.temperatureUnit}` : '';
  const apparent = Number.isFinite(weather.apparentTemperature)
    ? `feels ${Math.round(weather.apparentTemperature)}${weather.temperatureUnit}`
    : '';
  const condition = weather.condition || '';
  return [temp, condition, apparent].filter(Boolean).join(', ');
}

async function refreshWeather({ force = false } = {}) {
  if (!Number.isFinite(environment.latitude) || !Number.isFinite(environment.longitude)) return null;
  const cacheMs = Number(process.env.WEATHER_CACHE_MS || DEFAULT_WEATHER_CACHE_MS);
  if (!force && environment.weather && Date.now() - environment.weatherUpdatedAt < cacheMs) {
    return environment.weather;
  }

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(environment.latitude));
  url.searchParams.set('longitude', String(environment.longitude));
  url.searchParams.set('current', [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'precipitation',
    'weather_code',
    'wind_speed_10m',
  ].join(','));
  url.searchParams.set('temperature_unit', process.env.WEATHER_TEMPERATURE_UNIT || 'fahrenheit');
  url.searchParams.set('wind_speed_unit', process.env.WEATHER_WIND_SPEED_UNIT || 'mph');
  url.searchParams.set('timezone', environment.timeZone || 'auto');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const body = await res.json();
    const current = body.current || {};
    const units = body.current_units || {};
    environment.weather = {
      condition: WEATHER_CODES.get(Number(current.weather_code)) || 'Weather update',
      code: Number(current.weather_code),
      temperature: Number(current.temperature_2m),
      apparentTemperature: Number(current.apparent_temperature),
      humidity: Number(current.relative_humidity_2m),
      precipitation: Number(current.precipitation),
      windSpeed: Number(current.wind_speed_10m),
      temperatureUnit: units.temperature_2m || '°F',
      windSpeedUnit: units.wind_speed_10m || 'mph',
      observedAt: current.time || '',
      provider: 'Open-Meteo',
    };
    environment.weatherUpdatedAt = Date.now();
    environment.weatherError = '';
    return environment.weather;
  } catch (err) {
    environment.weatherError = err.message || 'Weather unavailable';
    return environment.weather;
  }
}

async function environmentSnapshot({ refreshWeather: shouldRefreshWeather = false } = {}) {
  if (shouldRefreshWeather) await refreshWeather();
  const time = currentTimeContext();
  return {
    ...time,
    locationLabel: environment.locationLabel,
    latitude: environment.latitude,
    longitude: environment.longitude,
    weather: environment.weather,
    weatherText: weatherText(),
    weatherUpdatedAt: environment.weatherUpdatedAt,
    weatherError: environment.weatherError,
  };
}

function environmentPromptText() {
  const time = currentTimeContext();
  const lines = [
    `Local date/time: ${time.date}, ${time.time} (${time.timeZone})`,
  ];
  if (environment.locationLabel) lines.push(`Location: ${environment.locationLabel}`);
  const weather = weatherText();
  if (weather) lines.push(`Weather: ${weather}`);
  else if (environment.weatherError) lines.push(`Weather: unavailable (${environment.weatherError})`);
  return lines.join('\n');
}

module.exports = {
  currentTimeContext,
  environmentPromptText,
  environmentSnapshot,
  refreshWeather,
  updateEnvironment,
};
