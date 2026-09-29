'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geocodeAddress, parseYandexGeocoderResponse } = require('./geocoding');

const yandexResult = {
  response: {
    GeoObjectCollection: {
      featureMember: [{
        GeoObject: {
          Point: { pos: '92.852572 56.010569' },
          metaDataProperty: {
            GeocoderMetaData: {
              text: 'Россия, Красноярск, улица Ленина, 1',
              precision: 'exact',
            },
          },
        },
      }],
    },
  },
};

test('разбирает порядок координат Яндекс Геокодера: долгота, затем широта', () => {
  assert.deepEqual(parseYandexGeocoderResponse(yandexResult), {
    lat: 56.010569,
    lng: 92.852572,
    formattedAddress: 'Россия, Красноярск, улица Ленина, 1',
    precision: 'exact',
  });
});

test('возвращает null, когда адрес не найден', () => {
  assert.equal(parseYandexGeocoderResponse({
    response: { GeoObjectCollection: { featureMember: [] } },
  }), null);
});

test('передаёт полный адрес в HTTP Геокодер', async () => {
  let requestedUrl;
  const result = await geocodeAddress('Красноярск, улица Ленина, 1', {
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => yandexResult };
    },
  });

  assert.equal(requestedUrl.searchParams.get('geocode'), 'Красноярск, улица Ленина, 1');
  assert.equal(requestedUrl.searchParams.get('apikey'), 'test-key');
  assert.equal(result.lat, 56.010569);
  assert.equal(result.lng, 92.852572);
});

test('не принимает пустой ответ как координаты точки', async () => {
  await assert.rejects(
    geocodeAddress('Красноярск, неизвестный адрес', {
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ response: { GeoObjectCollection: { featureMember: [] } } }),
      }),
    }),
    (error) => error.code === 'ADDRESS_NOT_FOUND'
  );
});

test('не ставит точку в центр города при слишком неточном адресе', async () => {
  const impreciseResult = structuredClone(yandexResult);
  impreciseResult.response.GeoObjectCollection.featureMember[0]
    .GeoObject.metaDataProperty.GeocoderMetaData.precision = 'other';

  await assert.rejects(
    geocodeAddress('Красноярск, неизвестное место', {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: true, json: async () => impreciseResult }),
    }),
    (error) => error.code === 'ADDRESS_TOO_IMPRECISE'
  );
});
