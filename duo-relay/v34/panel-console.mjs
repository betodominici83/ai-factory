import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';

const data=process.env.DUO_WORKERS_DATA||(process.platform==='win32'?'C:\\ROBOT\\DUO_DATA\\WORKERS':path.resolve('.duo-workers-data'));
const state=path.join(data,'state'),portFile=path.join(state,'workers-v34.port'),tokenFile=path.join(state,'panel-v34.token');
let stopped=false,lastError='',lastNotice='';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ansi=process.stdout.isTTY;const C={reset:'\x1b[0m',green:'\x1b[92m',yellow:'\x1b[93m',red:'\x1b[91m',cyan:'\x1b[96m',gray:'\x1b[90m',white:'\x1b[97m'};
const col=(c,s)=>ansi?C[c]+s+C.reset:s;const G=s=>col('green',s),Y=s=>col('yellow',s),R=s=>col('red',s),B=s=>col('cyan',s),D=s=>col('gray',s);
function cls(){process.stdout.write('\x1b[2J\x1b[H')}
function readText(p){try{return fs.readFileSync(p,'utf8').trim()}catch{return''}}
function request(method,port,url,token=''){return new Promise(resolve=>{const headers={};if(token)headers['x-duo-token']=token;if(method==='POST')headers['content-type']='application/json';const q=http.request({host:'127.0.0.1',port,path:url,method,headers,timeout:10000},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{resolve({ok:r.statusCode>=200&&r.statusCode<300,status:r.statusCode,json:JSON.parse(s)})}catch{resolve({ok:false,status:r.statusCode,error:'JSON_INVALID'})}})});q.on('timeout',()=>{q.destroy();resolve({ok:false,error:'TIMEOUT'})});q.on('error',e=>resolve({ok:false,error:e.message}));if(method==='POST')q.write('{}');q.end()})}
function line(label,value){console.log(label.padEnd(32)+': '+value)}function cut(s,n){s=String(s??'');return s.length>n?s.slice(0,n-1)+'…':s}function yes(v){return v?G('SI'):R('NO')}
function money(x,conf='NONE',period='UNKNOWN'){if(x==null)return'-';const suffix=period&&period!=='UNKNOWN'?(' / '+period):'';return `${conf==='HIGH'?'USD':'~USD'} ${x}${suffix}`}
function workerState(w){const s=String(w.state||'READY');if(s==='WORKING'||s==='PASS'||s==='RECORDED'||s==='READY_FOR_PLATFORM_ACTION')return G(s);if(s.includes('WAITING')||s.includes('HUMAN_GATE')||s.includes('LOGIN'))return Y(s);if(s==='ERROR')return R(s);return D(s)}
function eventIcon(t=''){t=String(t);if(t.includes('ERROR'))return'🔴';if(t.includes('WAIT')||t.includes('REPAIR'))return'🟡';if(t.includes('DONE')||t.includes('CONNECTED')||t.includes('PASS'))return'🟢';return'🔵'}
async function action(pathname){const port=Number(readText(portFile))||0,token=readText(tokenFile);if(!port||!token){lastError='Runtime/token no disponible';return null}const r=await request('POST',port,pathname,token);if(!r.ok){lastError=r.error||('HTTP '+r.status);return r}lastError='';return r}
async function connectEdge(){const r=await action('/api/browser/connect-current');if(!r?.ok)return;const j=r.json||{};if(j.connected){lastNotice=j.tab?.createdNewTab?'🟢 Mismo Edge conectado. Se abrió UNA pestaña de trabajo.':'🟢 Mismo Edge conectado/reutilizado.'}else lastNotice='🟡 V34 todavía no obtuvo control del Edge. Revisá ACTIVIDAD EN VIVO.'}
async function repairEdge(){const r=await action('/api/browser/repair');if(!r?.ok)return;const j=r.json||{};lastNotice=j.repair?.ok?'🟢 Reparación Edge PASS.':'🟡 Reparación Edge: '+(j.repair?.reason||'sin conexión');if(j.repair?.ok)await connectEdge()}
async function draw(){
 const port=Number(readText(portFile))||0;let s=null;if(port){const r=await request('GET',port,'/api/status');if(r.ok)s=r.json;else lastError=r.error||('HTTP '+r.status)}
 cls();console.log(B('================================================================================'));
 console.log(B(' DOMINICI DUO - WORK CENTER V34 - ONE PROMPT FACTORY / MISMO EDGE CONTROLADO'));
 console.log(B('================================================================================'));
 if(!s){line('Runtime',R('🔴 OFFLINE / reconectando'));line('Puerto',String(port||'-'));line('Ultimo error',R(lastError||'-'))}
 else{
  line('Runtime',G('🟢 ONLINE V'+s.version));line('Puerto',String(s.sidecar?.port||port));line('Core 8787',s.core?.online===true?G('🟢 ONLINE'):s.core?.online===false?R('🔴 OFFLINE'):Y('🟡 PROBANDO'));
  line('Workers habilitados',G(`🟢 ${s.workers?.enabled||0} / ${s.workers?.total||0}`));line('Workers ejecutando ahora',String(s.workers?.busy||0));line('Radar',s.autopilot?.paused?Y('🟡 PAUSADO'):s.autopilot?.running?G('🟢 TRABAJANDO AHORA'):G('🟢 ACTIVO EN BACKGROUND'));
  line('Ciclos realizados',String(s.autopilot?.cycles??0));line('Oportunidades elegibles',String(s.opportunities?.total??0));line('Trabajos en ledger',String(s.ledger?.total??0));line('Concretados',s.ledger?.concreted?G('🟢 '+String(s.ledger.concreted)):Y('🟡 0'));
  const br=s.browser||{};if(br.online)line('Edge actual',G(`🟢 CONECTADO MISMO EDGE (${br.endpointSource||'CDP'})`));else line('Edge actual',Y('🟡 SIN CONTROL - AUTORREPARACIÓN ACTIVA'));
  line('Autorreparación Edge',br.selfRepairEnabled?G('🟢 ON - máximo 1 reinicio controlado'):Y('🟡 OFF'));line('Nueva ventana Edge automática',G('🟢 OFF'));line('Pestañas mismo Edge',G('🟢 ON - max '+(br.maxManagedTabs||3)));line('Ganancia CONFIRMADA',`${s.earnings?.currency||'USD'} ${s.earnings?.confirmed??0}`);
  console.log('\n'+B('WORKERS:'));for(const w of s.workers?.items||[])console.log(` ${eventIcon(w.state)} ${String(w.id).padEnd(12)} ${String(workerState(w)).padEnd(38)} ${cut(w.lastAction||'',58)}${w.lastError?' '+R('ERR='+w.lastError):''}`);
  const c=s.currentWork;if(c){console.log('\n'+B('TRABAJO ACTUAL / ULTIMO:'));line('WEB',String(c.web||c.platformId||'-').toUpperCase());line('TRABAJO',cut(c.title,110));line('ESTADO',String(c.stage||c.status||'-'));line('CONCRETADO',yes(c.concreted));line('OFERTA PUBLICADA',money(c.advertisedPay,c.payConfidence,c.payPeriod));line('GANADO CONFIRMADO',`${c.currency||'USD'} ${c.earnedConfirmed||0}`);line('BLOQUEO',c.blocker?Y(c.blocker):G('NINGUNO'));if(c.url)line('URL',cut(c.url,118))}
  console.log('\n'+B('ULTIMOS TRABAJOS:'));console.log('WEB'.padEnd(12)+'TRABAJO'.padEnd(42)+'ESTADO'.padEnd(30)+'HECHO'.padEnd(8)+'OFERTA'.padEnd(18)+'GANADO');for(const j of (s.ledger?.items||[]).slice(0,8)){console.log(String(j.web||'-').toUpperCase().padEnd(12)+cut(j.title,40).padEnd(42)+cut(j.stage||j.status,28).padEnd(30)+(j.concreted?'SI':'NO').padEnd(8)+cut(money(j.advertisedPay,j.payConfidence,j.payPeriod),16).padEnd(18)+`${j.currency||'USD'} ${j.earnedConfirmed||0}`)}
  console.log('\n'+B('ACTIVIDAD EN VIVO:'));const ev=(s.activity||[]).slice(0,12);if(!ev.length)console.log(D('  Sin eventos todavía.'));for(const e of ev){const tm=String(e.at||'').slice(11,19);console.log(`${eventIcon(e.type)} ${tm} ${cut(e.type,18).padEnd(20)} ${cut(e.message||'',92)}`)}
  if(!br.online)console.log('\n'+Y('🟡 V34 intentará una reparación controlada cuando el Executor necesite Edge. Backup antes de reiniciar; sin loop.'));
  if(s.autopilot?.lastError)console.log('\n'+R('ULTIMO ERROR CICLO: '+s.autopilot.lastError));
 }
 if(lastNotice)console.log('\n'+B('AVISO: ')+lastNotice);if(lastError)console.log('\n'+R('ERROR: '+lastError));
 console.log('\n'+B('[B] CONECTAR EDGE   [X] REPARAR EDGE   [T] TRABAJAR   [P] PAUSAR   [R] REANUDAR   [Q] CERRAR PANEL'));
 console.log(D('El panel puede cerrarse: los workers siguen. V34 no abre una ventana Edge por cada ciclo.'));
}
if(process.stdin.isTTY){readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('keypress',async(_s,k)=>{if(k?.ctrl&&k?.name==='c'){stopped=true;process.exit(0)}const n=String(k?.name||'').toLowerCase();if(n==='b')await connectEdge();else if(n==='x')await repairEdge();else if(n==='t')await action('/api/control/work-cycle');else if(n==='p')await action('/api/control/pause');else if(n==='r')await action('/api/control/resume');else if(n==='q'){stopped=true;process.exit(0)}await draw()})}
while(!stopped){await draw();await sleep(2500)}
