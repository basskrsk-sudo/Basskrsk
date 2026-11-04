// Versioned static assets only: never cache authenticated HTML or APIs.
// A stale page returned by an older service worker could strand Telegram Mini App
// on an incompatible bundle after rollout. Offline access is read-only at best.
const CACHE_NAME = 'hvostmarket-shell-v65-reliability-20261104';
const SHELL_FILES = [
  '/favicon.svg',
  '/favicon.ico',
  '/images/icons/icon-192.png',
  '/images/icons/icon-512.png',
];

self.addEventListener('install', function(event){
  event.waitUntil(caches.open(CACHE_NAME).then(function(cache){
    return Promise.all(SHELL_FILES.map(function(url){
      return fetch(url).then(function(res){
        return res.ok ? cache.put(url,res) : null;
      }).catch(function(){});
    }));
  }).catch(function(){}));
  self.skipWaiting();
});
self.addEventListener('activate',function(event){
  event.waitUntil(caches.keys().then(function(names){
    return Promise.all(names.filter(function(name){
      return name.startsWith('hvostmarket-shell-') && name!==CACHE_NAME;
    }).map(function(name){return caches.delete(name);}));
  }));
  self.clients.claim();
});
self.addEventListener('fetch',function(event){
  var request=event.request;
  if(request.method!=='GET')return;
  var url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  // Never intercept navigation, Mini App login shells, private accounts, or
  // config and SW scripts. Returning old HTML/JS may leak stale role state.
  if(request.mode==='navigate' || url.pathname.startsWith('/api/') ||
      url.pathname.endsWith('.html') || url.pathname==='/config.js' ||
      url.pathname==='/sw.js')return;
  var isIcon=SHELL_FILES.includes(url.pathname);
  var version=url.searchParams.get('v');
  // The server generates SHA-256 20-char asset versions.
  var isImmutable=/^[a-f0-9]{20}$/.test(version||'') &&
    /\.(?:js|css|png|jpg|jpeg|webp|svg|woff2|ico)$/.test(url.pathname);
  if(!isIcon && !isImmutable)return;
  event.respondWith(
    fetch(request).then(function(response){
      if(response && response.ok && response.type!=='opaque'){
        var copy=response.clone();
        caches.open(CACHE_NAME).then(function(cache){return cache.put(request,copy);}).catch(function(){});
      }
      return response;
    }).catch(function(){return caches.match(request);})
  );
});
