const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Readable}=require('node:stream');
const {createHandler}=require('../api/texts');
const {createFileStore,activeRecords}=require('../lib/storage');
const {validateFile,MAX_FILE_SIZE}=require('../lib/files');
async function request(handler,method,body,room='ROOM01',params='') {
  const req=Readable.from(body === undefined? []:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{method,url:`/api/texts?room=${room}${params}`,headers:{}});
  let result;
  const res={setHeader(){},writeHead(status){this.status=status},end(body){result={status:this.status,body:JSON.parse(body)}}};
  await handler(req,res); return result;
}
async function setup(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'transfer-rooms-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,handler:createHandler(room=>createFileStore(directory,room))};
}
const pdf={name:'sample.pdf',type:'application/pdf',base64:Buffer.from('%PDF-1.4\nlocal test\n%%EOF').toString('base64')};

test('one shared feed assigns unique four-digit IDs and ignores obsolete room parameters',async t=>{
  const {handler}=await setup(t);
  const replies=await Promise.all(Array.from({length:60},(_,i)=>request(handler,'POST',{text:'share '+i,requestId:'share_request_identifier_'+i},i%2?'ROOM01':'ROOM02')));
  assert.ok(replies.every(r=>r.status===201));
  const ids=replies.map(r=>r.body.item.id);
  assert.ok(ids.every(id=>/^\d{4}$/.test(id)));
  assert.equal(new Set(ids).size,60);
  assert.equal((await request(handler,'GET')).body.texts.length,60);
  const found=await request(handler,'GET',undefined,'IGNORED','&q='+ids[0]);
  assert.equal(found.body.texts[0].id,ids[0]);
  assert.equal(replies[0].body.item.expiresAt-replies[0].body.item.createdAt,11*60*60*1000);
});

test('PDF bytes persist; retry is idempotent; deleting the transfer deletes its attachment',async t=>{
  const {handler,directory}=await setup(t);
  const body={text:'document',file:pdf,requestId:'file_request_identifier'};
  const uploaded=await request(handler,'POST',body);
  assert.equal(uploaded.status,201);
  assert.equal(uploaded.body.item.file.name,'sample.pdf');
  assert.equal((await request(handler,'POST',body)).status,200);
  const store=createFileStore(directory);
  assert.equal((await store.readFile(uploaded.body.item.file.storageId)).toString(),'%PDF-1.4\nlocal test\n%%EOF');
  await request(handler,'DELETE',undefined,'ROOM01','&id='+uploaded.body.item.id);
  await assert.rejects(store.readFile(uploaded.body.item.file.storageId),{code:'ENOENT'});
});

test('server rejects unsupported, disguised, malformed and oversized attachments',async t=>{
  const {handler}=await setup(t);
  const cases=[
    {...pdf,type:'text/html'}, {...pdf,name:'sample.html'}, {...pdf,base64:Buffer.from('fake pdf').toString('base64')},
    {...pdf,name:'../sample.pdf'}, {...pdf,base64:'not!base64'},
  ];
  for(const file of cases) assert.equal((await request(handler,'POST',{text:'',file})).status,400);
  const big=Buffer.alloc(MAX_FILE_SIZE+1);big.write('%PDF-');
  assert.equal((await request(handler,'POST',{text:'',file:{...pdf,base64:big.toString('base64')}})).status,413);
  const edge=Buffer.alloc(MAX_FILE_SIZE);edge.write('%PDF-');
  assert.equal(validateFile({...pdf,base64:edge.toString('base64')}).buffer.length,MAX_FILE_SIZE);
});

test('expiry removes attachments as well as metadata',async t=>{
  const {handler,directory}=await setup(t);
  const uploaded=await request(handler,'POST',{text:'',file:pdf});
  const store=createFileStore(directory);
  assert.equal((await activeRecords(store,uploaded.body.item.expiresAt+1)).length,0);
  await assert.rejects(store.readFile(uploaded.body.item.file.storageId),{code:'ENOENT'});
});

test('search and transfer links find records older than the newest 200 cards',async t=>{
  const {handler,directory}=await setup(t);
  const store=createFileStore(directory);
  await Promise.all(Array.from({length:205},(_,i)=>store.add({id:'item_'+i,text:i===0?'older needle':'new entry',createdAt:Date.now()+i,expiresAt:Date.now()+39600000})));
  assert.equal((await request(handler,'GET')).body.texts.length,200);
  const searched=await request(handler,'GET',undefined,'ROOM01','&q=needle');
  assert.equal(searched.body.texts.length,1);assert.equal(searched.body.texts[0].id,'item_0');
  assert.ok((await request(handler,'GET',undefined,'ROOM01','&id=item_0')).body.texts.some(item=>item.id==='item_0'));
});

test('file-storage and metadata failures never acknowledge an unsaved attachment',async()=>{
  const factories=[
    ()=>({list:async()=>[],add:async item=>item,putFile:async()=>{throw Error('file storage unavailable');}}),
    ()=>({list:async()=>[],putFile:async()=>'/api/files?id=orphan',add:async()=>{throw Error('metadata unavailable');}})
  ];
  for(const factory of factories) assert.equal((await request(createHandler(factory),'POST',{text:'',file:pdf})).status,503);
});

test('forced four-digit hash collisions preserve both simultaneous shares',async t=>{
 const crypto=require('node:crypto');const {handler}=await setup(t);const seen=new Map();let pair;
 for(let i=0;i<20000;i++){const requestId='collision_request_'+i;const slot=crypto.createHash('sha256').update(requestId).digest().readUInt32BE(0)%10000;if(seen.has(slot)){pair=[seen.get(slot),requestId];break;}seen.set(slot,requestId);}
 assert.ok(pair);
 const replies=await Promise.all(pair.map((requestId,i)=>request(handler,'POST',{text:'collision '+i,requestId})));
 assert.ok(replies.every(r=>r.status===201));assert.notEqual(replies[0].body.item.id,replies[1].body.item.id);
 const retries=await Promise.all(pair.map((requestId,i)=>request(handler,'POST',{text:'collision '+i,requestId})));
 assert.deepEqual(retries.map(r=>r.body.item.id),replies.map(r=>r.body.item.id));
});
