import fs from 'node:fs';
import path from 'node:path';
import {platformMap,settings} from './config.mjs';
import {statePath} from './paths.mjs';
import {detectHumanGate} from './humanGate.mjs';
import {rankCandidates,estimateValueScore} from './opportunityScanner.mjs';
import {readActivePort as readRepairActivePort,diagnoseSameEdge,repairSameEdgeConnection} from './edgeSessionRepair.mjs';

let chromium=null,hub=null;
const workers=new Map();
let closedHandler=()=>{};
const nowIso=()=>new Date().toISOString();
const fixedDebugPort=()=>Number(settings.browserBridge?.remoteDebugPort||9222);
const autoTabCooldownMs=()=>Math.max(60,Number(settings.browserBridge?.autoTabCooldownSec||21600))*1000;
const tabHistoryFile=()=>statePath('edge-tab-history-v34.json');

export function setWorkerClosedHandler(fn){closedHandler=typeof fn==='function'?fn:()=>{}}
async function getChromium(){if(!chromium)({chromium}=await import('playwright'));return chromium}
function edgeUserDataDir(){
  if(process.env.DUO_EDGE_USER_DATA_DIR)return process.env.DUO_EDGE_USER_DATA_DIR;
  if(process.platform==='win32'&&process.env.LOCALAPPDATA)return path.join(process.env.LOCALAPPDATA,'Microsoft','Edge','User Data');
  return '';
}
function readActivePort(){return readRepairActivePort()}
function loadHistory(){try{const j=JSON.parse(fs.readFileSync(tabHistoryFile(),'utf8'));return j&&typeof j==='object'?j:{}}catch{return{}}}
function saveHistory(j){try{fs.writeFileSync(tabHistoryFile(),JSON.stringify(j,null,2),'utf8')}catch{}}
function markOpened(key,extra={}){const j=loadHistory();j[key]={at:Date.now(),...extra};saveHistory(j)}
function openedRecently(key){const j=loadHistory(),x=j[key];return !!(x&&Number(x.at)>0&&(Date.now()-Number(x.at)<autoTabCooldownMs()))}
function platformFromUrl(raw){try{const h=new URL(raw).hostname.toLowerCase();for(const p of platformMap.values()){if(!p.browserEnabled)continue;if((p.expectedHosts||[]).some(x=>h===x||h.endsWith('.'+x)))return p}}catch{}return null}
function samePlatformUrl(raw,p){try{const h=new URL(raw).hostname.toLowerCase();return (p.expectedHosts||[]).some(x=>h===x||h.endsWith('.'+x))}catch{return false}}
function bindClose(rec){rec.page.on('close',()=>{if(workers.get(rec.workerId)===rec){workers.delete(rec.workerId);try{closedHandler({...rec,reason:'TAB_CLOSED'})}catch{}}})}
function snap(w){return {workerId:w.workerId,platformId:w.platformId,status:w.status,title:w.title||'',url:w.page.url(),createdAt:w.createdAt,adopted:!!w.adopted,managedByDuo:!!w.managedByDuo,browserMode:'SAME_RUNNING_EDGE_SINGLETON',visibility:'SAME_EDGE_TAB',lastScanAt:w.lastScanAt||null,loginRequired:!!w.loginRequired,humanGate:w.humanGate||{required:false,reasons:[]}}}

async function tryConnect(endpoint,source,meta={}){
  const c=await getChromium();
  try{
    const browser=await c.connectOverCDP(endpoint,{timeout:1800});
    const ctx=browser.contexts()[0];
    if(!ctx){await browser.close().catch(()=>{});return null}
    hub={browser,ctx,connectedAt:nowIso(),endpoint,source,...meta};
    browser.once?.('disconnected',()=>{hub=null;workers.clear()});
    return hub;
  }catch{return null}
}
export async function connectExistingEdge({attemptRepair=false,onEvent=()=>{}}={}){
  if(hub?.browser?.isConnected?.())return hub;
  let active=readActivePort();
  if(active){
    const httpEndpoint=`http://127.0.0.1:${active.port}`;
    const h=await tryConnect(httpEndpoint,'DEVTOOLS_ACTIVE_PORT',active);
    if(h)return h;
    if(active.wsPath){const ws=`ws://127.0.0.1:${active.port}${active.wsPath.startsWith('/')?'':'/'}${active.wsPath}`;const h2=await tryConnect(ws,'DEVTOOLS_ACTIVE_PORT_WS',active);if(h2)return h2}
  }
  const p=fixedDebugPort();
  const fixed=await tryConnect(`http://127.0.0.1:${p}`,'FIXED_PORT',{port:p,userDataDir:edgeUserDataDir()});
  if(fixed)return fixed;
  if(attemptRepair&&settings.browserBridge?.autoRepairSameEdge){
    const repair=await repairSameEdgeConnection({onEvent});
    if(repair?.ok){
      active=readActivePort();
      if(active){
        const h=await tryConnect(`http://127.0.0.1:${active.port}`,'SELF_REPAIRED_ACTIVE_PORT',active);
        if(h)return h;
      }
      const h2=await tryConnect(`http://127.0.0.1:${p}`,'SELF_REPAIRED_FIXED_PORT',{port:p,userDataDir:edgeUserDataDir()});
      if(h2)return h2;
    }
  }
  return null;
}
export async function diagnoseExistingEdge(){return await diagnoseSameEdge()}
export async function repairExistingEdge(onEvent=()=>{}){hub=null;workers.clear();const r=await repairSameEdgeConnection({onEvent});if(r?.ok)return {repair:r,hub:await connectExistingEdge()};return {repair:r,hub:null}}
export function hubStatus(){
  const active=readActivePort();
  const online=!!hub?.browser?.isConnected?.();
  return {
    online,
    sameRunningEdge:true,
    endpointSource:hub?.source||null,
    debugPort:hub?.port||active?.port||fixedDebugPort(),
    userDataDir:hub?.userDataDir||active?.userDataDir||edgeUserDataDir()||null,
    remoteDebugEnabled:online||!!active,
    needsOneTimeEnable:!online&&!active,
    autoLaunchEdge:false,
    autoOpenEdge:false,
    autoRestartEdge:false,
    autoNewWindow:false,
    autoNewTab:false,
    jobScopedTabs:true,
    maxManagedTabs:Number(settings.browserBridge?.maxManagedTabs||3),
    tabCount:workers.size,
    mode:'SAME_RUNNING_EDGE_SINGLETON',
    selfRepairEnabled:!!settings.browserBridge?.autoRepairSameEdge,
    controlledRestartAllowed:!!settings.browserBridge?.controlledRestartAllowed
  };
}
export async function adoptExistingPages(){
  const h=await connectExistingEdge();
  if(!h)return {connected:false,adopted:0,total:0,reason:'EDGE_REMOTE_DEBUG_NOT_AVAILABLE'};
  let adopted=0;
  for(const page of h.ctx.pages()){
    if(page.isClosed?.())continue;
    const p=platformFromUrl(page.url());if(!p)continue;
    let rec=[...workers.values()].find(w=>w.platformId===p.id&&!w.page.isClosed?.());if(rec)continue;
    rec={workerId:`W-${p.id}`,platformId:p.id,page,createdAt:nowIso(),status:'ADOPTED',title:await page.title().catch(()=>''),lastScanAt:null,loginRequired:false,humanGate:{required:false,reasons:[]},adopted:true,managedByDuo:false};
    workers.set(rec.workerId,rec);bindClose(rec);adopted++;
  }
  return {connected:true,adopted,total:workers.size};
}
export async function ensurePlatformTab(platformId,targetUrl=null,jobId=null){
  const p=platformMap.get(platformId);if(!p||!p.browserEnabled){const e=new Error('PLATFORM_BROWSER_DISABLED');e.code='PLATFORM_BROWSER_DISABLED';throw e}
  const h=await connectExistingEdge({attemptRepair:true});
  if(!h){const e=new Error('EDGE_REMOTE_DEBUG_REQUIRED: habilite una vez edge://inspect > Remote debugging > Allow remote debugging for this browser instance.');e.code='EDGE_REMOTE_DEBUG_REQUIRED';throw e}
  await adoptExistingPages();
  let rec=[...workers.values()].find(w=>w.platformId===platformId&&!w.page.isClosed?.());
  if(rec){
    if(targetUrl&&samePlatformUrl(targetUrl,p)&&rec.page.url()!==targetUrl){await rec.page.goto(targetUrl,{waitUntil:'commit',timeout:15000}).catch(()=>{})}
    rec.status='REUSED';rec.title=await rec.page.title().catch(()=>rec.title||'');return {...snap(rec),createdNewTab:false,reused:true};
  }
  const managedCount=[...workers.values()].filter(w=>w.managedByDuo&&!w.page.isClosed?.()).length;
  if(managedCount>=Number(settings.browserBridge?.maxManagedTabs||3)){const e=new Error('EDGE_MANAGED_TAB_LIMIT');e.code='EDGE_MANAGED_TAB_LIMIT';throw e}
  const url=(targetUrl&&samePlatformUrl(targetUrl,p))?targetUrl:p.publicUrl;
  const key=`${platformId}:${jobId||url}`;
  if(openedRecently(key)){const e=new Error('EDGE_TAB_REOPEN_COOLDOWN');e.code='EDGE_TAB_REOPEN_COOLDOWN';throw e}
  const page=await h.ctx.newPage();
  rec={workerId:`W-${platformId}`,platformId,page,createdAt:nowIso(),status:'OPENED_FOR_JOB',title:'',lastScanAt:null,loginRequired:false,humanGate:{required:false,reasons:[]},adopted:false,managedByDuo:true};
  workers.set(rec.workerId,rec);bindClose(rec);markOpened(key,{platformId,jobId,url});
  await page.goto(url,{waitUntil:'commit',timeout:18000}).catch(()=>{});rec.title=await page.title().catch(()=>'');
  return {...snap(rec),createdNewTab:true,reused:false};
}
export function listWorkers(){return [...workers.values()].map(snap)}
export async function openWorker(platformId,targetUrl=null,jobId=null){return await ensurePlatformTab(platformId,targetUrl,jobId)}
export async function closeWorker(workerId){const w=workers.get(workerId);if(!w)return false;workers.delete(workerId);return true}
export async function focusWorker(workerId){const w=workers.get(workerId);if(!w)throw new Error('WORKER_NOT_FOUND');await w.page.bringToFront().catch(()=>{});return snap(w)}
export async function focusHub(){const w=[...workers.values()][0];if(!w)throw new Error('NO_PLATFORM_TAB');return focusWorker(w.workerId)}
export async function minimizeHub(){return hubStatus()}
export async function closeHub(){workers.clear();hub=null;return true}
export async function enterLoginMode(workerId){const w=workers.get(workerId);if(!w)throw new Error('WORKER_NOT_FOUND');w.loginRequired=true;w.status='LOGIN_MODE';return snap(w)}
export async function finishLoginMode(workerId){const w=workers.get(workerId);if(!w)throw new Error('WORKER_NOT_FOUND');w.loginRequired=false;w.status='READY';return snap(w)}

export async function scanWorker(workerId,max=60,maxChars=1800){
  const w=workers.get(workerId);if(!w)throw new Error('WORKER_NOT_FOUND');
  const page=w.page;await page.waitForLoadState('domcontentloaded',{timeout:4500}).catch(()=>{});
  const title=await page.title().catch(()=>''),url=page.url();const body=await page.locator('body').innerText({timeout:8000}).catch(()=>'');
  const gate=detectHumanGate(body.slice(0,100000));const passwordInputs=await page.locator('input[type="password"]').count().catch(()=>0);
  const loginRequired=passwordInputs>0||(/login|sign in|iniciar sesi[oó]n/i.test(body.slice(0,6000))&&/login|signin|auth|account/i.test(url));
  if(loginRequired){w.loginRequired=true;w.status='NEEDS_LOGIN';w.humanGate=gate;w.lastScanAt=nowIso();return {at:w.lastScanAt,workerId,platformId:w.platformId,title,url,loginRequired:true,humanGate:gate,candidates:[],scanEligible:false,source:'SAME_EDGE_TAB'}}
  let items=await page.locator('article, li, tr, [role="listitem"], [class*="card" i], [class*="job" i], [class*="task" i], [class*="project" i]').evaluateAll(els=>els.slice(0,700).map(e=>{const a=e.matches?.('a[href]')?e:e.querySelector?.('a[href]');return {text:e.innerText||'',href:a?.href||null}})).catch(()=>[]);
  if(items.length<3)items=body.split(/\n{2,}/).slice(0,400).map(text=>({text,href:null}));
  const candidates=rankCandidates(items,max,maxChars).map(c=>({...c,valueScore:estimateValueScore({baseScore:c.score,pay:c.pay,humanGate:gate.required,loginRequired:false,lane:c.lane})}));
  w.lastScanAt=nowIso();w.loginRequired=false;w.humanGate=gate;w.status=gate.required?'HUMAN_GATE':'SCANNED';
  return {at:w.lastScanAt,workerId,platformId:w.platformId,title,url,loginRequired:false,humanGate:gate,candidates:gate.required?[]:candidates,scanEligible:!gate.required,source:'SAME_EDGE_TAB'};
}
export async function scanAll(max=60,maxChars=1800){await adoptExistingPages();const out=[];for(const w of [...workers.values()]){try{out.push(await scanWorker(w.workerId,max,maxChars))}catch(e){out.push({at:nowIso(),workerId:w.workerId,platformId:w.platformId,error:e.message,candidates:[]})}}return out}
export async function inspectOpportunity(workerId,targetUrl,fallbackText=''){
  const w=workers.get(workerId);if(!w)throw new Error('WORKER_NOT_FOUND');const page=w.page;let navigationWarning=null;
  if(targetUrl){try{const t=new URL(targetUrl),c=new URL(page.url());if(t.hostname===c.hostname||t.hostname.endsWith('.'+c.hostname)||c.hostname.endsWith('.'+t.hostname)){await page.goto(targetUrl,{waitUntil:'commit',timeout:15000})}else navigationWarning='CROSS_HOST_NAV_BLOCKED'}catch(e){navigationWarning=e.message}}
  await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});const title=await page.title().catch(()=>''),url=page.url(),body=await page.locator('body').innerText({timeout:8000}).catch(()=>fallbackText||'');
  const buttons=await page.locator('button, a[role="button"], input[type="submit"]').evaluateAll(els=>els.slice(0,100).map((e,i)=>({text:(e.innerText||e.value||'').trim(),index:i}))).catch(()=>[]);
  return {page,title,url,body,buttons,navigationWarning,reusedExistingTab:true};
}
export async function claimInspectedPage(){throw new Error('V34_HUMAN_GATE_BEFORE_PLATFORM_COMMIT');}
