# Тайга — сервер сайта. Node 22+ обязателен: используется встроенный node:sqlite
# (доступен начиная с Node 22.5), поэтому база данных работает без единой
# внешней npm-зависимости — nothing to "npm install" вообще.
FROM node:22-alpine

# API MAX использует цепочку Russian Trusted CA (Минцифры), которой нет в
# стандартном хранилище Alpine/Node.js. Берём оба публичных сертификата только
# с официального CDN Госуслуг, проверяем, что это действительно CA Минцифры,
# и добавляем их в хранилище контейнера. NODE_EXTRA_CA_CERTS нужен отдельно:
# встроенный fetch Node.js по умолчанию использует собственный набор корней.
RUN apk add --no-cache ca-certificates openssl curl font-dejavu && \
    curl --fail --silent --show-error --location --retry 4 \
      https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
      --output /usr/local/share/ca-certificates/russian_trusted_root_ca.crt && \
    curl --fail --silent --show-error --location --retry 4 \
      https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
      --output /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt && \
    openssl x509 -in /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
      -noout -subject | grep -F 'Russian Trusted Root CA' && \
    openssl x509 -in /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt \
      -noout -subject | grep -F 'Russian Trusted Sub CA' && \
    update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# ImageMagick — для сжатия/изменения размера картинок товаров и фотографий
# салонов, загружаемых через кабинеты (без него сервер не сможет обработать
# загруженные изображения).
# Повторяем попытку установки несколько раз с паузой — репозиторий Alpine CDN
# иногда временно недоступен по TLS, и без ретраев одна такая заминка валит
# всю сборку образа целиком (весь новый код просто не доезжает до продакшена).
RUN for i in 1 2 3 4 5; do \
      apk add --no-cache imagemagick && break; \
      echo "Попытка $i установить imagemagick не удалась, повтор через 5с..."; \
      sleep 5; \
    done; \
    which convert || (echo "ImageMagick не установился после 5 попыток — останавливаем сборку." && exit 1)

# На части сборок Alpine пакет imagemagick сам по себе не тянет за собой
# библиотеку поддержки JPEG отдельным пакетом (в отличие от Debian/Ubuntu,
# где она обычно уже внутри). Пробуем доустановить явно — безопасно: если
# пакета с таким именем в этой версии Alpine нет, просто идём дальше без
# ошибки, сборка от этого не пострадает.
RUN apk add --no-cache libjpeg-turbo jpeg 2>/dev/null || true

# То же самое для WEBP — ImageMagick на Alpine записывает .webp не напрямую,
# а через ВНЕШНЮЮ программу-делегат `cwebp` (в отличие от связки в песочнице
# при разработке, где поддержка webp вкомпилирована прямо в convert). Без
# этого пакета чтение любой картинки проходит нормально, а сохранение в webp
# падает с "delegate failed `cwebp`" — ровно то, что показали логи прода.
RUN apk add --no-cache libwebp libwebp-tools 2>/dev/null || true

# Проверка "бинарник существует" сама по себе НЕДОСТАТОЧНА — на некоторых
# сборках Alpine пакет imagemagick ставится, но без рабочей поддержки JPEG
# (нет декодера), и тогда `convert` есть, а реально обработать фото не может —
# ошибка проявляется только в проде при попытке владельца загрузить фото
# товара, а не здесь при сборке. Поэтому дополнительно реально пробуем
# сконвертировать тестовую картинку в JPEG и обратно прямо сейчас. Намеренно
# НЕ останавливаем сборку при провале — это только загрузка фото товаров,
# а не критичная для работы магазина функция (оплата, заказы и всё остальное
# должны продолжать работать, даже если с картинками окажется проблема) —
# просто громко предупреждаем в логах сборки, чтобы проблему было видно
# сразу при деплое, а не только когда кто-то пожалуется на загрузку фото.
RUN (convert -size 10x10 xc:red /tmp/selftest.jpg && \
    convert /tmp/selftest.jpg -resize 5x5 /tmp/selftest-out.webp && \
    rm -f /tmp/selftest.jpg /tmp/selftest-out.webp && \
    echo "✅ ImageMagick: проверка чтения JPEG и записи WEBP прошла успешно.") || \
    echo "⚠️⚠️⚠️ ВНИМАНИЕ: ImageMagick не может обработать JPEG→WEBP в этой сборке Alpine — загрузка фото товаров и салонов работать НЕ БУДЕТ. Остальной сайт продолжит работать нормально. ⚠️⚠️⚠️"

WORKDIR /app

# Сам сервер и статические файлы сайта
COPY package.json ./
COPY server ./server
COPY public ./public

EXPOSE 80
ENV PORT=80

# ВАЖНО: база данных (SQLite) должна жить в постоянном хранилище Amvera,
# а не в /app — эта папка пересобирается заново при каждом деплое.
# На Amvera постоянное хранилище монтируется в /data по умолчанию.
ENV DATA_DIR=/data

CMD ["node", "server/server.js"]
