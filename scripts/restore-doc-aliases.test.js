'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {legacyAlias,restoreAliases}=require('./restore-doc-aliases');
test('checked-in Russian PDF aliases are byte-identical to all canonical files',()=>{
  const root=path.join(__dirname,'..','public','docs');
  const canonical=fs.readdirSync(root).filter(f=>f.endsWith('.pdf')&&/[\u0400-\u04ff]/.test(f));
  assert.ok(canonical.length>=12);
  for(const file of canonical){
    const alias=legacyAlias(file);
    assert.notEqual(alias,file);
    assert.ok(fs.existsSync(path.join(root,alias)), 'missing alias '+alias);
    assert.ok(fs.readFileSync(path.join(root,alias)).equals(fs.readFileSync(path.join(root,file))),
      'different bytes for '+file);
  }
});
test('recreated symlinks retain both legacy and modern URLs and exact bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hm-pdf-'));
  try{
    fs.writeFileSync(path.join(root,'Путь_покупателя.pdf'),'%PDF-1.4 example');
    fs.writeFileSync(path.join(root,'Инструкция_QR-коды.pdf'),'%PDF-1.4 QR');
    assert.equal(restoreAliases(root),2);
    for(const name of ['Путь_покупателя.pdf','Инструкция_QR-коды.pdf']){
      const link=path.join(root,legacyAlias(name));
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.ok(fs.statSync(link).isFile());
      assert.equal(fs.readlinkSync(link),name);
      assert.deepEqual(fs.readFileSync(link),fs.readFileSync(path.join(root,name)));
    }
    assert.equal(restoreAliases(root),0);
  }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('Docker image excludes tests/duplicates but restores old document paths',()=>{
  const root=path.join(__dirname,'..');
  const ignore=fs.readFileSync(path.join(root,'.dockerignore'),'utf8');
  const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  assert.match(ignore,/^server\/\*\.test\.js$/m);
  assert.match(ignore,/^public\/docs\/#U\*\.pdf$/m);
  assert.match(docker,/COPY server \.\/server/);
  assert.match(docker,/COPY public \.\/public/);
  assert.match(docker,/COPY scripts\/restore-doc-aliases\.js/);
  assert.match(docker,/RUN node \.\/scripts\/restore-doc-aliases\.js/);
});
