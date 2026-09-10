const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('Stacked.html', 'utf8').replace(/\r\n/g, '\n');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);

async function leaderboardTests(){
  const cache = new Map();
  const rows = Array.from({length:1205}, (_,i) => ({id:i+1, player_id:'p'+i, name:'Player '+i, score:i}));
  rows.push({id:1206, player_id:'another-device', name:'  PLAYER 0  ', score:9999});
  rows.push({id:1207, player_id:'third-device', name:'Player 0', score:500});
  rows.push({id:1208, player_id:null, name:'player 0', score:20});
  rows.push({id:1209, player_id:'blank', name:'   ', score:99999});
  let offline = false;
  const ranges = [];
  const context = vm.createContext({getDeviceId:()=> 'p0', console:{warn(){}}, setCloudStatus(){},
    localStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},
    supabaseClient:{from:()=>({select(){return this},order(){return this},async range(a,b){
      ranges.push([a,b]); return offline ? {error:Error('offline')} : {data:rows.slice(a,b+1)};
    }})}
  });
  vm.runInContext(html.slice(html.indexOf('const Store = {'), html.indexOf('/* ============================================================\n   GAME STATE'))+'\nglobalThis.store = Store;',context);
  let result = await context.store.getLeaderboard();
  assert.equal(result.length,1205, 'show every unique username, with no duplicates');
  assert.equal(result[0].score,9999);
  assert.equal(result[0].name,'  PLAYER 0  ');
  assert.equal(result.filter(e=>e.name.trim().toLowerCase()==='player 0').length,1,
    'same-name runs across devices, casing, whitespace, and legacy rows must share one best score');
  assert.equal(ranges.length,4, 'fetch until empty, including beyond 1000 rows');
  offline=true;
  result=await context.store.getLeaderboard();
  assert.equal(result.length,1205);
  assert.equal(result[0].score,9999, 'cached scores must also show only the highest score per name');
  assert.equal(context.store.leaderboardOnline,false);
  offline=false; rows.length=0;
  result=await context.store.getLeaderboard();
  assert.equal(result.length,0, 'empty cloud results must replace stale cache');
  assert.equal(cache.get('island_stack_lb_cache'),'[]');
}

function loopTests(){
  let id=0, updates=0, elapsed=0;
  const callbacks=new Map();
  const context=vm.createContext({
    requestAnimationFrame:cb=>{callbacks.set(++id,cb);return id},
    cancelAnimationFrame:id=>callbacks.delete(id),
    update:dt=>{updates++;elapsed+=dt;assert.ok(dt<=1/120)},render(){}
  });
  const loop=html.slice(html.indexOf('function stopLoop(){'),html.indexOf('function syncVideos(){'));
  vm.runInContext('let running=false, animationFrame=null, lastTime=0;'+loop,context);
  vm.runInContext('startLoop();startLoop();startLoop();',context);
  assert.equal(callbacks.size,1,'restart must leave exactly one animation loop');
  function frame(ts){const [key,cb]=callbacks.entries().next().value; callbacks.delete(key); cb(ts)}
  frame(100);frame(150);
  assert.ok(updates>=6);
  assert.ok(Math.abs(elapsed-.05)<1e-9);
  vm.runInContext('stopLoop()',context);
  assert.equal(callbacks.size,0);
  vm.runInContext('startLoop()',context);
  frame(100000);
  assert.ok(Math.abs(elapsed-.05)<1e-9,'resume must not simulate paused time');
  assert.ok(!html.includes('setTimeout(()=>triggerGameOver()'),'game-over must use simulation time');
}

(async()=>{await leaderboardTests();loopTests();console.log('PASS: script syntax, leaderboard pagination/unique usernames/cache, single animation loop, pause/resume timing');})().catch(e=>{console.error(e);process.exitCode=1});
