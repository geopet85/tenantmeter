import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;

test('SQLite iterators retain their statements through explicit GC during validation and streamed reports/compare/diff', {skip: !supported}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenantmeter-sqlite-lifetime-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import timers from 'node:timers/promises';
      import {syncBuiltinESMExports} from 'node:module';
      import {writeFile} from 'node:fs/promises';
      import {join} from 'node:path';
      import {DiskStore} from ${JSON.stringify(new URL('../src/disk.ts', import.meta.url).href)};
      import {newState} from ${JSON.stringify(new URL('../src/model.ts', import.meta.url).href)};
      import {compareDisk, diffDisk} from ${JSON.stringify(new URL('../src/disk-commands.ts', import.meta.url).href)};
      import {renderChunks} from ${JSON.stringify(new URL('../src/report.ts', import.meta.url).href)};
      const immediate = timers.setImmediate;
      timers.setImmediate = async (...args) => {
        const result = await immediate(...args);
        global.gc();
        return result;
      };
      syncBuiltinESMExports();
      const dir = process.argv[1];
      const path = join(dir, 'state.sqlite');
      const state = newState({provider:'demo',bucket:'demo-bucket',region:'auto',prefix:'',pattern:'customers/{tenant_id}/*'});
      for(let i=0;i<3000;i++) state.tenants['tenant-'+i]={bytes:'1',objects:1};
      state.objects=3000; state.bytes='3000'; state.pages=3001; state.requests=3001;
      state.status='complete'; state.reason='complete'; state.finishedAt=state.startedAt;
      const created = await DiskStore.importJson(path,state);
      // Exercise the separate cursor validation iterator across GC as well.
      created.db.exec('BEGIN');
      const insert = created.db.prepare('INSERT INTO cursors(cursor) VALUES(?)');
      for(let i=0;i<2000;i++) insert.run('cursor-'+i);
      created.db.exec('COMMIT'); created.close();
      const store = await DiskStore.open(path,{readOnly:true});
      try {
        let count=0;
        for(const row of store.rows()) {
          assert.equal(row.bytes,'1');
          if(++count%127===0) { await immediate(); global.gc(); }
        }
        assert.equal(count,3000);
        const snapshot={state:store.state(),count:store.tenantCount(),rows:()=>store.rows(),get:id=>store.get(id)};
        async function read(chunks) {
          let text='',count=0;
          for(const chunk of chunks) {
            text+=chunk;
            if(++count%127===0) { await immediate(); global.gc(); }
          }
          return JSON.parse(text);
        }
        const report = await read(renderChunks(store.state(),'json',20,snapshot));
        assert.equal(report.tenants.length,3000);
        const counters=join(dir,'counters.csv');
        await writeFile(counters,'tenant_id,bytes\\n'+Object.keys(state.tenants).map(id=>id+',1').join('\\n')+'\\n');
        const comparison=await compareDisk(snapshot,counters);
        try {
          const result=await read(comparison.chunks('json',20));
          assert.equal(result.rows.length,3000); assert.equal(result.different,0);
        } finally {await comparison.close();}
        const after={...state,bytes:'6000',tenants:Object.fromEntries(Object.keys(state.tenants).map(id=>[id,{bytes:'2',objects:1}]))};
        const afterSnapshot={state:after,count:3000,*rows(){for(const [tenantId,totals]of Object.entries(after.tenants))yield{tenantId,...totals}},get:id=>after.tenants[id]};
        const diff=await diffDisk(snapshot,afterSnapshot);
        try {
          const result=await read(diff.chunks('json',20));
          assert.equal(result.rows.length,3000); assert.equal(result.different,3000);
          assert.equal(result.total.deltaBytes,'3000');
        } finally {await diff.close();}
      } finally {store.close();}
      console.log('validated 3000 tenants, 2000 cursors, report, compare and diff with forced GC');
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script, dir],
      {encoding: 'utf8', timeout: 60000});
    assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /validated 3000 tenants, 2000 cursors, report, compare and diff with forced GC/);
  } finally {await rm(dir, {recursive: true, force: true});}
});
