import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { load } from 'cheerio';

function environment() {
  const events = new Map(), storage = new Map(), timers = new Map();
  let timer = 0;
  const root = { dataset: {}, style: { values: {}, setProperty(k,v) { this.values[k]=v; } },
    setAttribute(k,v) { this.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v; },
    getAttribute(k) { return this.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())] || null; } };
  const nodes = new Map();
  const document = { documentElement:root, hidden:false, readyState:'loading', activeElement:null,
    querySelectorAll:()=>[], querySelector:()=>null, getElementById:id=>nodes.get(id)||null,
    addEventListener(name,fn) { if(!events.has(name)) events.set(name,[]);events.get(name).push(fn); },
    dispatchEvent(e) { for(const fn of events.get(e.type)||[]) fn(e); } };
  const context = { window:{}, document, location:{search:''}, console, Date, Math,
    CustomEvent:class { constructor(type,options) { this.type=type;Object.assign(this,options); } },
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    setTimeout:(fn,ms)=>{timers.set(++timer,{fn,ms});return timer;}, clearTimeout:id=>timers.delete(id),
    setInterval:()=>++timer, clearInterval:()=>{}, getComputedStyle:()=>({display:'block'}),
  };
  context.window.innerHeight=800;
  vm.createContext(context);
  return {context,root,storage,timers,nodes,document,run:name=>vm.runInContext(fs.readFileSync('public/js/'+name+'.js','utf8'),context)};
}
const env=environment();env.run('daylight');env.run('theme');
const {ThemeManager:theme,Daylight:daylight}=env.context.window;
for(const [hour,key] of [[6,'dawn'],[12,'paper'],[18,'ember'],[22,'midnight']]) {
  daylight.publish(hour*60);assert.equal(theme.currentTheme,key);assert.equal(env.root.dataset.tone,theme.themes[key].scheme);
}
theme.setMode('light');daylight.publish(23*60);assert.equal(env.root.dataset.theme,'light');assert.equal(env.root.style.values['--surface'],'#fffefb');
theme.setMode('dark');daylight.publish(12*60);assert.equal(env.root.dataset.theme,'dark');
theme.nextTheme();assert.equal(theme.mode,'auto');assert.equal(theme.currentTheme,'paper');
assert.equal(env.storage.get('blog-theme-mode'),'auto');
daylight.setHour(23);theme.setMode('light');const lightArt=Number(env.root.style.values['--art-brightness']);
theme.setMode('dark');assert.ok(Number(env.root.style.values['--art-brightness'])<lightArt,'art brightness follows theme immediately');
daylight.setHour(6);daylight.refresh();assert.equal(env.root.dataset.period,'dawn','manual sky preview survives scheduled refresh');
daylight.setHour(NaN);assert.equal(daylight.preview,null,'invalid sky preview falls back to current time');
env.storage.set('blog-theme-mode','invalid');theme.init();assert.equal(theme.mode,'auto');

const pet=environment();let calls=0,states=[];
pet.context.fetch=()=>{calls++;throw new Error('Unexpected ambient AI request');};
pet.context.window.PetBoot={engine:{setState:state=>states.push(state)}};
pet.run('pet-mind');const mind=pet.context.window.PetMind;
await mind.autoTalk(true);assert.equal(calls,0);assert.ok(states.includes('curious'),'article-page engine fallback receives state');
mind.setQuiet(true);const before=states.length;await mind.autoTalk(true);assert.equal(states.length,before);assert.equal(pet.storage.get('pet-quiet'),'true');
mind.setQuiet(false);assert.ok(pet.timers.size>0,'resuming companionship restarts scheduler');
pet.nodes.set('deskPet',{dataset:{state:'sleep'}});await mind.autoTalk(true);assert.equal(states.length,before,'sleep suppresses ambient greeting');

// Deferred head scripts run while readyState is interactive, before later theme scripts.
const startup=environment();startup.document.readyState='interactive';let injected=0;
startup.document.createElement=()=>{injected++;throw new Error('Premature dynamic script injection');};
startup.run('experience');assert.equal(injected,0,'shared experience waits until all deferred scripts have run');

const chat=environment(), handlers={};let resolveRequest;
const sendButton={disabled:false,setAttribute(){}}, form={setAttribute(){},querySelector:()=>sendButton,addEventListener:(name,fn)=>handlers[name]=fn};
const input={value:'第一条',focus(){}};
chat.nodes.set('petChat',{});chat.nodes.set('petChatForm',form);chat.nodes.set('petChatInput',input);
chat.context.AbortSignal=AbortSignal;
chat.context.fetch=()=>new Promise(resolve=>{resolveRequest=resolve;});
chat.run('pet-mind');chat.context.window.PetMind.start();
handlers.submit({preventDefault(){}});assert.equal(sendButton.disabled,true,'send button disabled during request');
input.value='不要丢掉这条草稿';handlers.submit({preventDefault(){}});assert.equal(input.value,'不要丢掉这条草稿','busy submit preserves unsent draft');
resolveRequest({ok:true,headers:{get:()=> 'application/json'},json:async()=>({choices:[{message:{content:'收到'}}]})});
await new Promise(resolve=>setImmediate(resolve));assert.equal(sendButton.disabled,false,'send button restored after response');

// Catch broken asset references and inline syntax on every top-level page.
let inline=0;
for(const name of fs.readdirSync('public').filter(name=>name.endsWith('.html'))) {
  const html=fs.readFileSync('public/'+name,'utf8'), $=load(html);
  $('script:not([src])').each((_,el)=>{if(!['module','application/ld+json','application/json'].includes($(el).attr('type'))){new vm.Script($(el).html()||'',{filename:name});inline++;}});
  $('script[src],link[rel="stylesheet"]').each((_,el)=>{
    const src=$(el).attr('src')||$(el).attr('href');
    if(!src||/^(https?:|\/\/|data:)/.test(src))return;
    assert.ok(fs.existsSync('public/'+src.split('?')[0].replace(/^\//,'')),`${name}: missing ${src}`);
  });
}
for(const name of ['app','theme','daylight','tone','experience','pet-mind'])new vm.Script(fs.readFileSync('public/js/'+name+'.js','utf8'),{filename:name});
const css=fs.readFileSync('public/css/sky.css','utf8');
assert.ok(!/html\[data-period="night"\]\s*\{/.test(css),'clock cannot override fixed light palette');
assert.ok(fs.readFileSync('public/css/bundle.css','utf8').includes(css.replace(/\r\n/g,'\n')),'homepage bundle includes updated sky source');
console.log(`UI checks passed: four periods, theme overrides/persistence, pet quiet/sleep/local greetings, assets, ${inline} inline scripts.`);
