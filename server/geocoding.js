'use strict';

const fs = require('node:fs');
const path = require('node:path');

let cachedApiKey;

function resolveYandexMapsApiKey() {
  if (cachedApiKey !== undefined) return cachedApiKey;

  const envKey = String(
    process.env.YANDEX_GEOCODER_API_KEY || process.env.YANDEX_MAPS_API_KEY || ''
  ).trim();
  if (envKey) {
    cachedApiKey = envKey;
    return cachedApiKey;
  }

  // В проекте ключ карты уже задаётся в публичном config.js. Используем его
  // и для HTTP-геокодера, чтобы после деплоя не требовалась ещё одна ручная
  // настройка. При наличии переменной окружения она всегда имеет приоритет.
  try {
    const configPath = path.join(__dirname, '..', 'public', 'config.js');
    const source = fs.readFileSync(configPath, 'utf8');
    const match = source.match(/YANDEX_MAPS_API_KEY\s*:\s*['"]([^'"]+)['"]/);
    cachedApiKey = match ? match[1].trim() : '';
  } catch (e) {
    cachedApiKey = '';
  }
  return cachedApiKey;
}

function parseYandexGeocoderResponse(data) {
  const member = data
    && data.response
    && data.response.GeoObjectCollection
    && data.response.GeoObjectCollection.featureMember
    && data.response.GeoObjectCollection.featureMember[0];
  const geoObject = member && member.GeoObject;
  const position = geoObject && geoObject.Point && geoObject.Point.pos;
  if (!position) return null;

  // Яндекс возвращает координаты в порядке «долгота широта».
  const [lng, lat] = String(position).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const metadata = geoObject.metaDataProperty && geoObject.metaDataProperty.GeocoderMetaData;
  return {
    lat,
    lng,
    formattedAddress: metadata && metadata.text ? metadata.text : '',
    precision: metadata && metadata.precision ? metadata.precision : '',
  };
}

async function geocodeAddress(address, options = {}) {
  const query = String(address || '').trim();
  if (!query) throw Object.assign(new Error('Не указан адрес для геокодирования'), { code: 'EMPTY_ADDRESS' });

  const apiKey = String(options.apiKey || resolveYandexMapsApiKey()).trim();
  if (!apiKey) {
    throw Object.assign(new Error('Не настроен ключ Яндекс.Карт'), { code: 'GEOCODER_NOT_CONFIGURED' });
  }

  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL('https://geocode-maps.yandex.ru/1.x/');
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('geocode', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('results', '1');
  url.searchParams.set('lang', 'ru_RU');

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs || 8000) });
  } catch (e) {
    throw Object.assign(new Error('Сервис определения координат временно недоступен'), {
      code: 'GEOCODER_UNAVAILABLE',
      cause: e,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error('Сервис определения координат вернул ошибку ' + response.status), {
      code: 'GEOCODER_UNAVAILABLE',
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw Object.assign(new Error('Некорректный ответ сервиса определения координат'), {
      code: 'GEOCODER_INVALID_RESPONSE',
      cause: e,
    });
  }
  const result = parseYandexGeocoderResponse(data);
  if (!result) {
    throw Object.assign(new Error('Адрес не найден'), { code: 'ADDRESS_NOT_FOUND' });
  }
  // Для бессмысленного или слишком общего запроса Яндекс может вернуть
  // центр города/области. Такая метка опаснее отсутствующей: клиент поедет
  // не туда. Принимаем дом, номер рядом с домом, диапазон домов или хотя бы
  // конкретную улицу; точность «other» просим уточнить.
  const acceptedPrecision = new Set(['exact', 'number', 'near', 'range', 'street']);
  if (result.precision && !acceptedPrecision.has(result.precision)) {
    throw Object.assign(new Error('Адрес определён слишком приблизительно'), {
      code: 'ADDRESS_TOO_IMPRECISE',
    });
  }
  return result;
}

module.exports = { geocodeAddress, parseYandexGeocoderResponse, resolveYandexMapsApiKey };
