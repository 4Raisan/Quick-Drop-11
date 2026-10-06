const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function browser(fetcher, saved = {}) {
  const values = new Map([['quickdrop_last_chat','TESTROOM'], ...Object.entries(saved)]);
  const elements = new Map(); const listeners = {};
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, value: '', textContent: '', innerHTML: '', style: {}, children: [],
      classList: { add(){}, remove(){}, contains(){return false;}, toggle(){} },
      addEventListener(key, fn){ this.listeners[key] = fn; }, appendChild(child){this.children.push(child);},
      querySelectorAll(){return [];}, setAttribute(){}, focus(){}, remove(){},
    });
    return elements.get(id);
  }
  const localStorage = { getItem:k => values.get(k) || null, setItem:(k,v) => values.set(k,v) };
  const document = {
    getElementById: element, body: element('body'), visibilityState:'visible',
    querySelector: () => element('status'), createElement: () => element(crypto.randomUUID()),
    addEventListener(){},
  };
  const sandbox = { document, localStorage, navigator:{onLine:true}, window:{addEventListener:(key,fn)=>listeners[key]=fn},
    crypto:{randomUUID:crypto.randomUUID}, fetch:fetcher, AbortSignal, URLSearchParams, URL, clearTimeout(){},
    location:{hash:'',origin:'http://localhost:3000'}, console, Date, setInterval(){}, setTimeout(){}, clearInterval(){},
    confirm:()=>true };
  const source = fs.readFileSync('public/script.js','utf8').replace(/\}\)\(\);\s*$/, 'window.testHooks = { selectAttachment, clearAttachment, getAttachment: () => selectedAttachment, queueNewText, processUploadQueue, deleteTextItem, getTexts: () => communityTexts }; })();');
  vm.runInNewContext(source, sandbox);
  return { hooks:sandbox.window.testHooks, values, elements, listeners };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = (status, body) => ({ ok:status>=200 && status<300, status, json:async()=>body });

test('offline uploads survive reload and retry with the same request ID', async () => {
  const failing = browser(async () => {throw new Error('offline');});
  failing.hooks.queueNewText('preserve offline text');
  await flush();
  const key='quickdrop_shared_outbox';
  const jobs=JSON.parse(failing.values.get(key));
  assert.equal(jobs.length,1);
  const sent=[];
  const restored = browser(async (url, options) => {
    if (options?.method==='POST') {
      const job=JSON.parse(options.body); sent.push(job);
      return reply(201,{item:{id:'comm_'+job.requestId,text:job.text,createdAt:Date.now(),expiresAt:Date.now()+86400000}});
    }
    return reply(200,{texts:[],serverTime:Date.now(),mode:'local'});
  }, {[key]: failing.values.get(key)});
  await flush();
  assert.equal(sent.length,1);
  assert.equal(sent[0].requestId,jobs[0].requestId);
  assert.equal(restored.values.get(key),'[]');
});

test('HTTP delete failures preserve the displayed snippet', async () => {
  const item={id:'comm_saved',text:'keep this',createdAt:Date.now(),expiresAt:Date.now()+86400000};
  const app=browser(async (url, options) => options?.method==='DELETE' ? reply(503,{error:'unavailable'}) : reply(200,{texts:[item],serverTime:Date.now()}));
  await flush();
  assert.equal(await app.hooks.deleteTextItem(item.id),false);
  assert.equal(app.hooks.getTexts().length,1);
});

test('deleting during an active upload cannot remove the next queued job', async () => {
  let finish;
  const app=browser(async (url, options) => {
    if (options?.method==='POST') {
      const job=JSON.parse(options.body);
      if (job.text==='first') return new Promise(resolve=>finish=()=>resolve(reply(201,{item:{id:'comm_'+job.requestId,text:job.text,createdAt:Date.now(),expiresAt:Date.now()+86400000}})));
      return reply(201,{item:{id:'comm_'+job.requestId,text:job.text,createdAt:Date.now(),expiresAt:Date.now()+86400000}});
    }
    return reply(200,{texts:[],serverTime:Date.now()});
  });
  app.hooks.queueNewText('first'); app.hooks.queueNewText('second');
  await flush();
  const jobs=JSON.parse(app.values.get('quickdrop_shared_outbox'));
  assert.equal(await app.hooks.deleteTextItem(jobs[0].tempId),false);
  assert.equal(JSON.parse(app.values.get('quickdrop_shared_outbox')).length,2);
  finish(); await flush();
  assert.equal(app.values.get('quickdrop_shared_outbox'),'[]');
});

test('file selection and dropping share validation and preserve an existing file on rejection',async()=>{
 const app=browser(async()=>reply(200,{texts:[]}));
 const good={name:'picture.png',type:'image/png',size:200};
 assert.equal(app.hooks.selectAttachment([good]),true);
 assert.equal(app.hooks.getAttachment(),good);
 assert.equal(app.elements.get('removeFileBtn').hidden,false);
 assert.equal(app.hooks.selectAttachment([{name:'bad.html',type:'text/html',size:100}]),false);
 assert.equal(app.hooks.getAttachment(),good);
 assert.equal(app.hooks.selectAttachment([{name:'large.pdf',type:'application/pdf',size:5*1024*1024+1}]),false);
 assert.equal(app.hooks.selectAttachment([good,good]),false);
 app.hooks.clearAttachment();
 assert.equal(app.hooks.getAttachment(),null);
 assert.equal(app.elements.get('removeFileBtn').hidden,true);
 let prevented=false,stopped=false;
 app.elements.get('dropZone').listeners.drop({dataTransfer:{files:[good]},preventDefault(){prevented=true},stopPropagation(){stopped=true}});
 assert.ok(prevented&&stopped);
 assert.equal(app.hooks.getAttachment(),good);
});

test('pasted media selects the attachment and keeps typed text intact',async()=>{
 const app=browser(async()=>reply(200,{texts:[]}));
 const input=app.elements.get('textInput');input.value='caption stays';
 const file={name:'document.pdf',type:'application/pdf',size:400};
 let prevented=false;
 input.listeners.paste({clipboardData:{files:[file]},preventDefault(){prevented=true}});
 assert.ok(prevented);assert.equal(app.hooks.getAttachment(),file);assert.equal(input.value,'caption stays');
});
