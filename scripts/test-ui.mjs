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

// 桌宠内核：单击 / 双击睡觉 / 拖拽记忆 / 气泡不越界
const core=environment();
const classListFor=()=>{const set=new Set();return{add:(...c)=>c.forEach(x=>set.add(x)),remove:(...c)=>c.forEach(x=>set.delete(x)),toggle:(c,on)=>{const v=on===undefined?!set.has(c):!!on;if(v)set.add(c);else set.delete(c);return v;},contains:c=>set.has(c)};};
function fakeNode(id,extra){
  const handlers=new Map();
  return Object.assign({
    id,classList:classListFor(),dataset:{},textContent:'',offsetWidth:58,offsetHeight:58,offsetLeft:0,offsetTop:0,
    style:{values:{},setProperty(k,v){this.values[k]=v;},removeProperty(k){delete this.values[k];}},
    addEventListener(name,fn){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);},
    dispatch(name,ev){for(const fn of handlers.get(name)||[])fn(ev);},
    getBoundingClientRect(){const w=core.context.window.innerWidth,h=core.context.window.innerHeight;return{left:w-90,top:h-90,width:58,height:58,right:w-32,bottom:h-32};},
  },extra);
}
const rafQueue=[];
core.context.window.innerWidth=1200;core.context.window.innerHeight=800;
core.context.window.requestAnimationFrame=fn=>{rafQueue.push(fn);return rafQueue.length;};
core.context.window.cancelAnimationFrame=()=>{};
const winHandlers=new Map();
core.context.window.addEventListener=(name,fn)=>{if(!winHandlers.has(name))winHandlers.set(name,[]);winHandlers.get(name).push(fn);};
const fireWin=(name,ev)=>{for(const fn of winHandlers.get(name)||[])fn(ev);};
const flushRaf=()=>{while(rafQueue.length)rafQueue.shift()(0);};
const petNode=fakeNode('deskPet'),bodyNode=fakeNode('deskPetBody',{setPointerCapture(){},releasePointerCapture(){}});
const bubbleNode=fakeNode('deskPetBubble',{offsetWidth:200,offsetHeight:60});
core.nodes.set('deskPet',petNode);core.nodes.set('deskPetBody',bodyNode);core.nodes.set('deskPetBubble',bubbleNode);
core.nodes.set('grokPet',fakeNode('grokPet'));
core.document.readyState='complete';
const engineStates=[];
core.context.window.GrokCharacter=class{constructor(){this.reduceMotion=false;}setState(name){engineStates.push(name);}setInk(){}};
core.run('pet-core');
const PetCore=core.context.window.PetCore;
assert.equal(PetCore.ready,true,'pet core boots without waiting for a page hook');
assert.ok(PetCore.engine,'engine is created as soon as the character script exists');
assert.ok(engineStates.includes('idle'),'engine starts in idle');
assert.ok(!core.storage.get('pet-asleep'),'default state is awake');

const press=(x=500,y=500)=>{bodyNode.dispatch('pointerdown',{button:0,pointerType:'mouse',clientX:x,clientY:y,cancelable:true,preventDefault(){}});};
const release=()=>fireWin('pointerup',{pointerId:1});

// 单击：立刻给动作反馈，不睡觉
press();release();flushRaf();
assert.equal(PetCore.sleeping,false,'single tap does not sleep');
assert.ok(engineStates.includes('excited'),'single tap plays a reaction');

// 拖拽：位置被夹在视口内并记住（按比例存）
press(500,500);fireWin('pointermove',{clientX:300,clientY:300});flushRaf();
assert.equal(petNode.style.left,'910px','drag moves the pet with the pointer');
assert.equal(petNode.style.top,'510px','drag moves the pet vertically');
release();flushRaf();
const saved=JSON.parse(core.storage.get('deskpet_pos_v2')||'null');
assert.ok(saved&&typeof saved.rx==='number','drag position is stored as a viewport ratio');

// 双击：睡觉并记住（先等过双击判定窗口，避免上一次单击被算进来）
await new Promise(resolve=>setTimeout(resolve,360));
press();release();            // 第 1 下：单击（记录点击时间）
press();release();            // 第 2 下：落在 340ms 窗口内 → 睡觉
flushRaf();
assert.equal(PetCore.sleeping,true,'double tap puts the pet to sleep');
assert.equal(petNode.dataset.state,'sleep');
assert.equal(core.storage.get('pet-asleep'),'1','sleep state survives reloads');
assert.ok(engineStates.includes('sleeping'));

// 睡着时不主动搭话（心智层负责抑制，这里确认状态可见）
assert.equal(PetCore.sleeping,true);

// 气泡：始终落在视口内，箭头跟着宠物
PetCore.say('测试一下气泡会不会跑出屏幕');
flushRaf();
const bubbleLeft=parseFloat(bubbleNode.style.left),bubbleTop=parseFloat(bubbleNode.style.top);
assert.ok(bubbleLeft>0&&bubbleLeft<1200,'bubble stays inside the viewport horizontally');
assert.ok(bubbleTop>=0&&bubbleTop+60<=800,'bubble stays inside the viewport vertically');
assert.ok(bubbleNode.style.values['--deskpet-arrow-x'],'bubble arrow is aligned to the pet');
assert.ok(PetCore.bounds().maxX<=1200-58,'bounds keep the pet clear of the right edge');

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
