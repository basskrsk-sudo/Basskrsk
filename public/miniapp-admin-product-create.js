// Administrator-only product creation using the existing shared catalog API.
// Warehouse receipts and salon allocations remain separate, auditable operations.
(function () {
  'use strict';
  var root = document.getElementById('workPage');
  if (!root) return;
  var state = {open:false,token:'',isValid:null,onBack:null,busy:false,serial:0,
    uploadedFile:null,uploadedPath:''};
  var categories = {treats:'Лакомства',toys:'Игрушки',accessories:'Аксессуары',care:'Уход'};
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g,function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function valid() {
    return state.open && !!state.token && typeof state.isValid === 'function' && state.isValid();
  }
  function note(message, error) {
    return '<p class="work-note" role="status" style="white-space:pre-wrap">' +
      (error ? '⚠️ ' : '') + esc(message) + '</p>';
  }
  function layout(inner) {
    root.innerHTML = '<div class="work-head"><h1>➕ Новый товар</h1>' +
      '<p>Единый каталог ХвостМаркета</p></div>' +
      '<button type="button" class="work-back" data-hm-product-action="back">' +
      '← Кабинет администратора</button>' + inner;
  }
  function renderForm() {
    if (!valid()) return;
    var choices = Object.keys(categories).map(function(key) {
      return '<option value="' + key + '">' + esc(categories[key]) + '</option>';
    }).join('');
    layout('<section class="work-surface"><h2>Создать карточку товара</h2>' +
      '<form id="hmNewProductForm" class="work-register-form">' +
      '<label class="work-register-label" for="hmNewProductName">Название *</label>' +
      '<input class="work-register-input" id="hmNewProductName" maxlength="120" required ' +
      'autocomplete="off" placeholder="Например: Сердце говяжье">' +
      '<label class="work-register-label" for="hmNewProductCategory">Категория *</label>' +
      '<select class="work-register-input" id="hmNewProductCategory" required>' + choices + '</select>' +
      '<label class="work-register-label" for="hmNewProductWeight">Фасовка / размер *</label>' +
      '<input class="work-register-input" id="hmNewProductWeight" maxlength="80" required ' +
      'placeholder="Например: 50 г или 5 шт.">' +
      '<label class="work-register-label" for="hmNewProductPrice">Цена, ₽ *</label>' +
      '<input class="work-register-input" id="hmNewProductPrice" type="number" inputmode="numeric" ' +
      'min="1" max="1000000" step="1" required placeholder="250">' +
      '<label class="work-register-label" for="hmNewProductDesc">Описание</label>' +
      '<textarea class="work-register-input" id="hmNewProductDesc" rows="3" maxlength="1500" ' +
      'placeholder="Кратко о товаре"></textarea>' +
      '<label class="work-register-label" for="hmNewProductComp">Состав (каждый компонент с новой строки)</label>' +
      '<textarea class="work-register-input" id="hmNewProductComp" rows="2" maxlength="1500"></textarea>' +
      '<label class="work-register-label" for="hmNewProductSuitability">Для каких питомцев</label>' +
      '<input class="work-register-input" id="hmNewProductSuitability" maxlength="300">' +
      '<label class="work-register-label" for="hmNewProductPurpose">Назначение</label>' +
      '<input class="work-register-input" id="hmNewProductPurpose" maxlength="300">' +
      '<label class="work-register-label" for="hmNewProductRestrictions">Ограничения / рекомендации</label>' +
      '<textarea class="work-register-input" id="hmNewProductRestrictions" rows="2" ' +
      'maxlength="700"></textarea>' +
      '<label class="work-register-label" for="hmNewProductPhoto">Фото товара (необязательно)</label>' +
      '<input class="work-register-input" id="hmNewProductPhoto" type="file" ' +
      'accept="image/jpeg,image/png,image/webp">' +
      '<p class="work-note">JPG, PNG или WebP до 15 МБ. Большие фото автоматически сжимаются.</p>' +
      '<div id="hmNewProductPhotoStatus" aria-live="polite"></div>' +
      '<div id="hmNewProductFeedback" aria-live="polite"></div>' +
      '<button class="work-primary" id="hmNewProductSubmit" type="submit">Создать товар</button>' +
      '</form></section>' +
      '<p class="work-quiet">Карточка создаётся в общем каталоге. Остатки на складе ' +
      'и во всех минимаркетах будут 0 шт. Для продажи товар нужно отдельно принять ' +
      'на центральный склад и распределить по точкам.</p>');
  }
  function renderSuccess(name, id) {
    if (!valid()) return;
    layout('<section class="work-surface"><h2>✅ Товар создан</h2>' +
      note('«' + name + '» добавлен в единый каталог (№ ' + id + '). ' +
        'Начальные остатки — 0 шт. Приход на склад оформляется отдельно.') +
      '<button type="button" class="work-primary" data-hm-product-action="again">' +
      '➕ Создать ещё один товар</button></section>');
  }
  function feedback(message, error) {
    var target = document.getElementById('hmNewProductFeedback');
    if (target) target.innerHTML = note(message, error);
  }
  function field(id) {
    var input = document.getElementById(id);
    return String(input && input.value || '').trim();
  }
  async function api(url, options) {
    var req = Object.assign({cache:'no-store'}, options || {});
    req.headers = Object.assign({}, req.headers || {},
      {Authorization:'Bearer ' + state.token});
    var response = await fetch(url, req);
    var data = await response.json().catch(function(){return null;});
    if (!response.ok) {
      var error = new Error((data && data.error) ||
        (response.status === 413 ? 'Фото слишком большое. Выберите файл меньшего размера.' :
          'Ошибка сервера: ' + response.status));
      error.status = response.status;
      throw error;
    }
    if (!data) throw new Error('Сервер вернул некорректный ответ. Проверьте каталог.');
    return data;
  }
  function makeSlug(name) {
    var map = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',
      и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',
      т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',
      ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
    var base = name.toLowerCase().split('').map(function(ch){
      return Object.prototype.hasOwnProperty.call(map,ch) ? map[ch] : ch;
    }).join('').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);
    return (base || 'tovar') + '-' + Date.now().toString(36) +
      Math.random().toString(36).slice(2,7);
  }
  async function preparePhoto(file) {
    if (!/^(image\/jpeg|image\/png|image\/webp)$/.test(file.type || ''))
      throw new Error('Выберите фотографию JPG, PNG или WebP.');
    if (!file.size || file.size > 15*1024*1024)
      throw new Error('Фото должно быть не больше 15 МБ.');
    var data = await new Promise(function(resolve,reject){
      var reader = new FileReader();
      reader.onload = function(){resolve(reader.result);};
      reader.onerror = function(){reject(new Error('Не удалось прочитать фото.'));};
      reader.readAsDataURL(file);
    });
    if (typeof data === 'string' && data.length <= 800000) return data;
    var url = URL.createObjectURL(file);
    try {
      var picture = new Image();
      await new Promise(function(resolve,reject){
        picture.onload = resolve;
        picture.onerror = function(){reject(new Error('Не удалось открыть фото.'));};
        picture.src = url;
      });
      var max = Math.max(picture.naturalWidth || 0, picture.naturalHeight || 0);
      if (!max) throw new Error('Не удалось определить размер фотографии.');
      for (var side of [1200,960,720,480]) {
        var canvas = document.createElement('canvas');
        var factor = Math.min(1,side/max);
        canvas.width = Math.max(1,Math.round(picture.naturalWidth*factor));
        canvas.height = Math.max(1,Math.round(picture.naturalHeight*factor));
        var context = canvas.getContext('2d');
        if (!context) throw new Error('Браузер не смог обработать фотографию.');
        context.drawImage(picture,0,0,canvas.width,canvas.height);
        for (var quality of [0.84,0.7,0.55]) {
          var compressed = canvas.toDataURL('image/webp',quality);
          if (/^data:image\/webp;/.test(compressed) && compressed.length <= 800000)
            return compressed;
          compressed = canvas.toDataURL('image/jpeg',quality);
          if (compressed.length <= 800000) return compressed;
        }
      }
      throw new Error('Не удалось сжать фото. Выберите файл меньшего размера.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function submit() {
    if (!valid() || state.busy) return;
    var name = field('hmNewProductName').replace(/\s+/g,' ');
    var category = field('hmNewProductCategory');
    var weight = field('hmNewProductWeight');
    var rawPrice = field('hmNewProductPrice');
    var price = Number(rawPrice);
    var desc = field('hmNewProductDesc') || name;
    var comp = field('hmNewProductComp').split(/\n+/).map(function(x){
      return x.trim();
    }).filter(Boolean);
    var suitability = field('hmNewProductSuitability');
    var purpose = field('hmNewProductPurpose');
    var restrictions = field('hmNewProductRestrictions');
    var photoNode = document.getElementById('hmNewProductPhoto');
    var photo = photoNode && photoNode.files && photoNode.files[0];
    var button = document.getElementById('hmNewProductSubmit');
    function fail(message){feedback(message,true);}
    if (name.length < 2 || name.length > 120) return fail('Название: от 2 до 120 символов.');
    if (!Object.prototype.hasOwnProperty.call(categories,category))
      return fail('Выберите категорию товара.');
    if (!weight || weight.length > 80) return fail('Укажите фасовку или размер до 80 символов.');
    if (!/^[0-9]+$/.test(rawPrice) || !Number.isSafeInteger(price) ||
        price < 1 || price > 1000000)
      return fail('Цена должна быть целым числом от 1 до 1 000 000 ₽.');
    if (desc.length > 1500 || comp.join('\n').length > 1500 ||
        suitability.length > 300 || purpose.length > 300 || restrictions.length > 700)
      return fail('Слишком длинное описание, состав или рекомендации.');
    if (photo && (!/^(image\/jpeg|image\/png|image\/webp)$/.test(photo.type || '') ||
        !photo.size || photo.size > 15*1024*1024))
      return fail('Фото: JPG/PNG/WebP, до 15 МБ. HEIC нужно пересохранить в JPEG.');
    state.busy = true;
    button.disabled = true;
    var stamp = state.serial;
    feedback('Сохраняем товар…');
    try {
      var imagePath = null;
      if (photo) {
        if (state.uploadedFile !== photo || !state.uploadedPath) {
          feedback('Сжимаем и загружаем фотографию…');
          var imageData = await preparePhoto(photo);
          if (!valid() || stamp !== state.serial) return;
          var uploaded = await api('/api/products/upload-image',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({data:imageData}),
          });
          if (!valid() || stamp !== state.serial) return;
          if (!uploaded.path || !/^\/?images\/uploads\//.test(uploaded.path))
            throw new Error('Сервер не подтвердил загрузку фотографии.');
          state.uploadedFile = photo;
          state.uploadedPath = uploaded.path;
        }
        imagePath = state.uploadedPath;
      }
      if (!valid() || stamp !== state.serial) return;
      var created = await api('/api/products',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          slug:makeSlug(name),name:name,category:category,icon:'🐾',badge:null,
          img:imagePath,desc:desc,comp:comp,pet_suitability:suitability,
          purpose:purpose,restrictions:restrictions,
          variants:[{weight:weight,price:price}],
        }),
      });
      if (!valid() || stamp !== state.serial) return;
      if (!created.ok || !created.id)
        throw new Error('Сервер не подтвердил создание. Проверьте каталог перед повтором.');
      renderSuccess(name,created.id);
    } catch(error) {
      if (!valid() || stamp !== state.serial) return;
      if (error.status === 401 || error.status === 403) return close();
      fail(error.message || 'Не удалось сохранить карточку.');
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  }
  function close(silent) {
    if (!state.open) return;
    var back = state.onBack;
    state.open = false; state.serial++; state.busy = false;
    state.token = ''; state.isValid = null; state.onBack = null;
    state.uploadedFile = null; state.uploadedPath = '';
    if (!silent && typeof back === 'function') return back();
  }
  root.addEventListener('click',function(event){
    if (!state.open || !event.target || !event.target.closest) return;
    var btn = event.target.closest('[data-hm-product-action]');
    if (!btn) return;
    if (event.preventDefault) event.preventDefault();
    if (btn.dataset.hmProductAction === 'back') return close();
    if (btn.dataset.hmProductAction === 'again') {
      state.uploadedFile = null; state.uploadedPath = '';
      return renderForm();
    }
  });
  root.addEventListener('change',function(event){
    if (!state.open || !event.target || event.target.id !== 'hmNewProductPhoto') return;
    state.uploadedFile = null; state.uploadedPath = '';
    var file = event.target.files && event.target.files[0];
    var target = document.getElementById('hmNewProductPhotoStatus');
    if (target) target.innerHTML = file ? note('Выбрано: ' + file.name) : '';
  });
  root.addEventListener('submit',function(event){
    if (!state.open || !event.target || event.target.id !== 'hmNewProductForm') return;
    event.preventDefault();
    return submit();
  });
  window.HvostAdminProductCreate = {
    open:function(opts){
      if (!opts || !opts.token || typeof opts.isValid !== 'function' || !opts.isValid()) return;
      state.open = true; state.token = opts.token; state.isValid = opts.isValid;
      state.onBack = opts.onBack; state.serial++; state.busy = false;
      state.uploadedFile = null; state.uploadedPath = '';
      renderForm();
    },
    close:close,
    isOpen:function(){return state.open;},
  };
})();