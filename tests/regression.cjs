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

async function scoreRecoveryTests(){
  const cache = new Map();
  const uploads = [];
  let failUpload = true;
  const context = vm.createContext({getDeviceId:()=> 'device', console:{warn(){}},setCloudStatus(){},
    profile:{},globalBestScore:0,window:{},
    localStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},
    supabaseClient:{from:()=>({select(){return this},order(){return this},async range(){return {data:[]}},
      async insert(rows){if(failUpload) return {error:Error('offline')};uploads.push(...rows);return {error:null}}
    })}
  });
  vm.runInContext(html.slice(html.indexOf('const Store = {'),html.indexOf('/* ============================================================\n   GAME STATE'))+'\nglobalThis.store = Store;',context);
  context.store.saveProfile=async()=>{};
  const entry={name:'Full Player Username',character:'zephy',score:25,perfect:2,jumps:3,combo:2};
  await context.store.submitScore(entry);
  assert.equal(JSON.parse(cache.get('island_stack_pending_scores')).length,1,'persist failed uploads');
  context.store.pendingRows=null; // Simulate reloading pending scores after a refresh.
  let list=await context.store.getLeaderboard();
  assert.equal(list[0].score,25,'an empty cloud response must not erase a pending score');
  assert.equal(list[0].name,entry.name,'preserve the complete username');
  failUpload=false;
  await Promise.all([context.store.flushScores(),context.store.flushScores()]);
  assert.equal(uploads.length,1,'concurrent retries share one upload queue');
  assert.equal(context.store.getPendingScores().length,0);
  assert.equal(cache.get('island_stack_pending_scores'),'[]');
  await context.store.submitScore({...entry,score:NaN});
  assert.equal(uploads.length,1,'reject invalid numeric scores');
  const deviceContext=vm.createContext({localStorage:{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}});
  vm.runInContext(html.slice(html.indexOf('let sessionDeviceId ='),html.indexOf('function updateHomePlayerBadge()'))+'\nglobalThis.deviceId=getDeviceId;',deviceContext);
  assert.equal(deviceContext.deviceId(),deviceContext.deviceId(),'identity remains stable when storage is unavailable');
}

async function profileAndSubmissionTests(){
  let resolveProfile;
  const currentProfile={name:'Old name',character:'zephy',bestScore:0,bestPerfect:0,bestJumps:0,bestCombo:0};
  const context=vm.createContext({profile:currentProfile,getDeviceId:()=> 'device',setCloudStatus(){},updateHomePlayerBadge(){},
    localStorage:{setItem(){}},console:{warn(){}},
    supabaseClient:{from:()=>({select(){return this},eq(){return this},maybeSingle(){return new Promise(resolve=>{resolveProfile=resolve})}})}
  });
  vm.runInContext(html.slice(html.indexOf('const Store = {'),html.indexOf('/* ============================================================\n   GAME STATE'))+'\nglobalThis.store = Store;',context);
  const syncing=context.store.syncProfileFromSupabase();
  currentProfile.name='New name';currentProfile.character='zara';
  resolveProfile({data:{name:'Old name',character:'zephy',best_score:50},error:null});
  await syncing;
  assert.equal(currentProfile.name,'New name','late cloud response must not overwrite a name edit');
  assert.equal(currentProfile.character,'zara');
  assert.equal(currentProfile.bestScore,50,'merge remote best stats despite a concurrent name edit');
  let submissions=0;
  const runContext=vm.createContext({jumpCount:2,score:10,perfectCount:1,bestCombo:1,selectedChar:'zephy',
    profile:{name:'Player'},Store:{async submitScore(){submissions++}}
  });
  const start=html.indexOf('let pendingScoreSave =');
  const end=html.indexOf('/* ============================================================',start);
  vm.runInContext(html.slice(start,end)+'\nglobalThis.submit=submitCurrentScore;',runContext);
  await Promise.all([runContext.submit(),runContext.submit()]);
  assert.equal(submissions,1,'one submission per run even when triggered repeatedly');
}

(async()=>{await leaderboardTests();await scoreRecoveryTests();await profileAndSubmissionTests();loopTests();console.log('PASS: syntax, unique leaderboard names/pagination/cache, offline score recovery, upload serialization, profile races, duplicate submission guard, stable device ID, animation/pause timing');})().catch(e=>{console.error(e);process.exitCode=1});
