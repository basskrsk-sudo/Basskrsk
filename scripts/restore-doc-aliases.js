'use strict';
// Recreate old URL aliases for Russian PDF filenames as same-directory symlinks.
// Copies are left in Git but omitted by .dockerignore in production.
const fs=require('node:fs'),path=require('node:path');
function legacyAlias(name){
  return Array.from(name,ch=>{
    const cp=ch.codePointAt(0);
    return cp>127&&cp<=65535?'#U'+cp.toString(16).padStart(4,'0'):ch;
  }).join('');
}
function restoreAliases(directory){
  const root=path.resolve(directory);
  let made=0;
  for(const name of fs.readdirSync(root)){
    if(!name.endsWith('.pdf')||!/[\u0400-\u04ff]/.test(name))continue;
    const alias=legacyAlias(name);
    if(alias===name)continue;
    const old=path.join(root,alias),target=path.join(root,name);
    if(fs.existsSync(old)){
      if(!fs.readFileSync(old).equals(fs.readFileSync(target)))throw new Error('PDF alias differs: '+alias);
      continue;
    }
    fs.symlinkSync(name,old,'file');
    made++;
  }
  return made;
}
if(require.main===module){
  console.log('Legacy PDF URL aliases restored:',restoreAliases(path.join(__dirname,'..','public','docs')));
}
module.exports={legacyAlias,restoreAliases};
