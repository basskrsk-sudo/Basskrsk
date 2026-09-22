// Общий загрузчик галереи салона для кабинетов администратора, менеджера,
// грумера и владельца. Фото загружаются по одному, но пользователь может
// выбрать сразу несколько файлов. Первый кадр считается обложкой.
(function () {
  'use strict';

  const galleries = new Map();
  const MAX_PHOTOS = 8;

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsDataURL(file);
    });
  }

  function showError(config, message) {
    const element = document.getElementById(config.errorId);
    if (!element) return;
    element.textContent = message;
    element.style.display = 'block';
  }

  function showStatus(config, message) {
    const element = document.getElementById(config.statusId);
    if (!element) return;
    element.textContent = message;
    element.style.display = message ? 'block' : 'none';
  }

  async function persistPhotos(key, successMessage) {
    const gallery = galleries.get(key);
    if (!gallery) return;
    const { config, photos } = gallery;
    const pointId = config.getPointId();
    if (!pointId) return;
    try {
      const response = await config.authFetch('/api/points/' + encodeURIComponent(pointId) + '/salon-page', {
        method: 'PUT',
        body: { salon_photo_urls: photos },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить галерею');
      gallery.photos = Array.isArray(result.photos) ? result.photos.slice() : photos;
      render(key);
      showStatus(config, successMessage);
    } catch (error) {
      showError(config, error.message || 'Не удалось сохранить галерею.');
    }
  }

  function render(key) {
    const gallery = galleries.get(key);
    if (!gallery) return;
    const { config, photos } = gallery;
    const container = document.getElementById(config.gridId);
    if (!container) return;
    container.innerHTML = '';

    if (!photos.length) {
      const empty = document.createElement('div');
      empty.textContent = 'Фотографии пока не загружены';
      empty.style.cssText = 'grid-column:1/-1;color:#8A7D6B;font-size:.78rem;padding:.75rem;border:1px dashed #D8D0C4;border-radius:8px;text-align:center;';
      container.appendChild(empty);
      return;
    }

    photos.forEach((url, index) => {
      const card = document.createElement('div');
      card.style.cssText = 'position:relative;border:1px solid #D8D0C4;border-radius:9px;overflow:hidden;background:#F5F1EA;min-height:105px;';

      const image = document.createElement('img');
      image.src = url;
      image.alt = 'Фото салона ' + (index + 1);
      image.style.cssText = 'display:block;width:100%;height:105px;object-fit:cover;';
      image.onerror = () => { image.style.display = 'none'; };
      card.appendChild(image);

      if (index === 0) {
        const cover = document.createElement('span');
        cover.textContent = 'Обложка';
        cover.style.cssText = 'position:absolute;left:5px;top:5px;background:#0A4A38;color:#fff;border-radius:5px;padding:2px 6px;font-size:10px;font-weight:600;';
        card.appendChild(cover);
      } else {
        const coverButton = document.createElement('button');
        coverButton.type = 'button';
        coverButton.textContent = 'На обложку';
        coverButton.style.cssText = 'position:absolute;left:5px;bottom:5px;border:0;border-radius:5px;padding:3px 6px;background:rgba(10,74,56,.9);color:#fff;font-size:10px;cursor:pointer;';
        coverButton.onclick = () => {
          gallery.photos.splice(index, 1);
          gallery.photos.unshift(url);
          render(key);
          persistPhotos(key, 'Фотография установлена как обложка.');
        };
        card.appendChild(coverButton);
      }

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.textContent = '×';
      removeButton.title = 'Убрать фотографию';
      removeButton.style.cssText = 'position:absolute;right:5px;top:5px;width:25px;height:25px;border:0;border-radius:50%;background:rgba(155,35,53,.92);color:#fff;font-size:18px;line-height:22px;cursor:pointer;';
      removeButton.onclick = () => {
        gallery.photos.splice(index, 1);
        render(key);
        persistPhotos(key, 'Фотография удалена из галереи.');
      };
      card.appendChild(removeButton);
      container.appendChild(card);
    });
  }

  async function upload(key, files) {
    const gallery = galleries.get(key);
    if (!gallery) return;
    const { config, photos } = gallery;
    const selected = Array.from(files || []);
    if (!selected.length) return;
    if (photos.length + selected.length > MAX_PHOTOS) {
      showError(config, `Можно разместить не больше ${MAX_PHOTOS} фотографий.`);
      return;
    }
    const pointId = config.getPointId();
    if (!pointId) {
      showError(config, 'Сначала выберите точку.');
      return;
    }
    const invalid = selected.find((file) => !/^image\/(jpeg|png|webp)$/i.test(file.type));
    if (invalid) {
      showError(config, 'Поддерживаются фотографии JPG, PNG и WebP.');
      return;
    }

    const errorElement = document.getElementById(config.errorId);
    if (errorElement) errorElement.style.display = 'none';
    const input = document.getElementById(config.inputId);
    if (input) input.disabled = true;
    try {
      for (let index = 0; index < selected.length; index += 1) {
        showStatus(config, `Загрузка ${index + 1} из ${selected.length}…`);
        const data = await readFile(selected[index]);
        const response = await config.authFetch('/api/points/' + encodeURIComponent(pointId) + '/salon-photos', {
          method: 'POST',
          body: { data },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось загрузить фотографию');
        photos.splice(0, photos.length, ...(Array.isArray(result.photos) ? result.photos : photos.concat(result.path)));
        render(key);
      }
      showStatus(config, 'Фото загружены и сохранены.');
    } catch (error) {
      showError(config, error.message || 'Не удалось загрузить фотографии.');
      showStatus(config, '');
    } finally {
      if (input) {
        input.disabled = false;
        input.value = '';
      }
    }
  }

  window.SalonPhotoGallery = {
    init(key, config) {
      if (!galleries.has(key)) galleries.set(key, { config, photos: [] });
      else galleries.get(key).config = config;
      const input = document.getElementById(config.inputId);
      if (input && !input.dataset.galleryBound) {
        input.dataset.galleryBound = '1';
        input.addEventListener('change', () => upload(key, input.files));
      }
      render(key);
    },
    set(key, values, legacyPhoto) {
      const gallery = galleries.get(key);
      if (!gallery) return;
      const source = Array.isArray(values) ? values : [];
      gallery.photos = [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, MAX_PHOTOS);
      if (!gallery.photos.length && legacyPhoto) gallery.photos.push(String(legacyPhoto));
      render(key);
      showStatus(gallery.config, '');
    },
    get(key) {
      const gallery = galleries.get(key);
      return gallery ? gallery.photos.slice() : [];
    },
  };
})();
