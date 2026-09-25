(function(){
  var config=null;
  function close(){
    if(!config)return;
    var sidebar=document.getElementById(config.sidebarId);
    var overlay=document.getElementById(config.overlayId);
    var button=document.querySelector('[data-cabinet-menu-button]');
    if(sidebar)sidebar.classList.remove('mobile-open');
    if(overlay)overlay.classList.remove('mobile-open');
    document.body.classList.remove('cabinet-menu-open');
    if(button)button.setAttribute('aria-expanded','false');
  }
  function toggle(){
    if(!config)return;
    var sidebar=document.getElementById(config.sidebarId);
    var open=!(sidebar&&sidebar.classList.contains('mobile-open'));
    if(sidebar)sidebar.classList.toggle('mobile-open',open);
    var overlay=document.getElementById(config.overlayId);
    if(overlay)overlay.classList.toggle('mobile-open',open);
    document.body.classList.toggle('cabinet-menu-open',open);
    var button=document.querySelector('[data-cabinet-menu-button]');
    if(button)button.setAttribute('aria-expanded',open?'true':'false');
  }
  function activate(sectionId){
    if(!config)return;
    var group=config.sectionGroups[sectionId];
    document.querySelectorAll('#'+config.sidebarId+' .nav-item[data-group]').forEach(function(button){
      button.classList.toggle('active',button.dataset.group===group);
    });
    var holder=document.getElementById(config.tabsId);
    var tabs=config.tabs[group]||[];
    if(holder){
      holder.style.display=tabs.length>1?'flex':'none';
      holder.innerHTML=tabs.map(function(tab){
        return '<button class="cabinet-context-tab '+(tab[0]===sectionId?'active':'')+'" type="button" onclick="showSec(\''+tab[0]+'\')">'+tab[1]+'</button>';
      }).join('');
    }
    close();
  }
  function init(options){config=options;activate(options.initialSection||'home')}
  document.addEventListener('keydown',function(event){if(event.key==='Escape')close()});
  window.addEventListener('resize',function(){if(window.innerWidth>768)close()});
  window.HvostCabinetNavigation={init:init,activate:activate,toggle:toggle,close:close};
})();
