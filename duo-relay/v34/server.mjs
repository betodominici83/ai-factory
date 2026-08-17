import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {URL} from 'node:url';
import {settings,platforms,platformMap} from './config.mjs';
import {ensureDataDirs,statePath} from './paths.mjs';
import {findFreePort} from './portFinder.mjs';
import {probeCore} from './coreAdapter.mjs';
import {connectExistingEdge,adoptExistingPages,ensurePlatformTab,hubStatus,listWorkers,scanAll,scanWorker,diagnoseExistingEdge,repairExistingEdge} from './browserManager.mjs';
import {scanPublicAll,publicRadarStatus} from './publicRadar.mjs';
import {mergeScan,listOpportunities,opportunityStats,resetOpportunities} from './opportunityStore.mjs';
import {detectLocalAI,analyzeOpportunityAI} from './localAI.mjs';
import {createPreparedJob,listJobs,stats as jobStats,updateJob} from './jobStore.mjs';
import {buildWorkPacket,qaWorkPacket,recordEvidence} from './workPacket.mjs';
import {upsertLedger,listLedger,ledgerStats} from './jobLedger.mjs';
import {startRelay,relayStatus} from './relayManager.mjs';
import {activity,recentActivity} from './activity.mjs';

ensureDataDirs();
if(settings.host!=='127.0.0.1')throw new Error('SECURITY_LOCALHOST_ONLY');
try{fs.unlinkSync(statePath('WORKERS_GLOBAL_STOP.flag'))}catch{}
const [a,b]=settings.portRange||[8788,8799];
const port=await findFreePort(settings.host,a,b);
fs.writeFileSync(statePath('workers-v34.port'),String(port),'utf8');
const tokenFile=statePath('panel-v34.token');let token='';try{token=fs.readFileSync(tokenFile,'utf8').trim()}catch{}if(!token){token=crypto.randomBytes(24).toString('hex');fs.writeFileSync(tokenFile,token,'utf8')}
const nowIso=()=>new Date().toISOString();
const testMode=process.env.DUO_TEST_MODE==='1';
const edgeRepairNotBefore=Date.now()+Math.max(0,Number(process.env.DUO_EDGE_REPAIR_DEFER_MS||0));
let paused=false,cycleRunning=false,lastCycle=null,lastCycleResult=null,lastCycleError=null,cycles=0,core={online:null,host:settings.core.host,port:settings.core.port},lastCoreProbe=null;
const virtualWorkers={
 RADAR_PRO:{id:'RADAR_PRO',role:'Opportunity Radar PRO',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando ciclo'},
 RADAR_MICRO:{id:'RADAR_MICRO',role:'Opportunity Radar MICRO',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando ciclo'},
 ANALYZER:{id:'ANALYZER',role:'Profitability + Local AI Analyzer',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando oportunidades'},
 EXECUTOR:{id:'EXECUTOR',role:'Local Prework / Platform Executor',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando trabajo elegible'},
 QA:{id:'QA',role:'QA / Repair Loop',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando paquete'},
 EVIDENCE:{id:'EVIDENCE',role:'Evidence Recorder',enabled:true,state:'READY',lastAt:null,lastError:null,lastAction:'Esperando evidencia'}
};
function setV(id,state,err=null,lastAction=null){if(!virtualWorkers[id])return;const prev=virtualWorkers[id].state;virtualWorkers[id].state=state;virtualWorkers[id].lastAt=nowIso();virtualWorkers[id].lastError=err;if(lastAction)virtualWorkers[id].lastAction=lastAction;if(prev!==state||lastAction)activity('WORKER',`${id} ${state}: ${lastAction||''}`,{workerId:id,state,error:err||null})}
async function refreshCore(){try{core=await probeCore();lastCoreProbe=nowIso()}catch(e){core={online:false,host:settings.core.host,port:settings.core.port,error:e.message};lastCoreProbe=nowIso()}}
function send(res,status,obj,type='application/json; charset=utf-8'){res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(type.startsWith('application/json')?JSON.stringify(obj):obj)}
const authed=req=>req.headers['x-duo-token']===token;
async function mergeBrowserScans(){const rs=await scanAll(settings.scanner.maxCandidates,settings.scanner.maxTextPerCandidate);for(const r of rs)if(!r.error&&!r.loginRequired&&!r.humanGate?.required)mergeScan(r);return rs}
function syntheticPublic(){return {skipped:false,results:[{at:nowIso(),platformId:'workana',title:'Mock Jobs',url:'https://example.test/jobs',source:'TEST_RADAR',candidates:[{text:'Python automation data extraction project. Fixed budget USD 75. Build CSV export and validation.',href:'https://example.test/job/1',score:20,valueScore:30,pay:75,payConfidence:'HIGH',payPeriod:'PROJECT',lane:'PRO_CANDIDATE',tags:['data','automation','PAY_CONTEXT_VERIFIED']}]}]}}
function blockerFor(opp,browserState={connected:false,loginRequired:false,tabReady:false,error:null}){
 const p=platformMap.get(opp.platformId);
 if(!browserState.connected)return browserState.error||'EDGE_REMOTE_DEBUG_REQUIRED';
 if(browserState.loginRequired)return 'PLATFORM_LOGIN_REQUIRED';
 if(!browserState.tabReady)return browserState.error||'PLATFORM_TAB_NOT_READY';
 if(p?.priority==='PRO')return 'HUMAN_GATE_BEFORE_APPLICATION_OR_CONTRACT';
 if(/TASK_RULES_CHECK_REQUIRED|PROJECT_RULES_CHECK_REQUIRED/.test(p?.policy||''))return 'TASK_RULES_CONFIRMATION_REQUIRED';
 return null;
}
async function prepareOne(opp,browserConnected){
 setV('EXECUTOR','WORKING',null,`Preparando ${opp.platformId}: ${String(opp.text||'').slice(0,70)}`);
 const ai=await analyzeOpportunityAI(opp);
 const job=createPreparedJob({opportunity:opp,analysis:{title:String(opp.text||'').slice(0,140),url:opp.href||opp.url,compatible:true,claimable:false,humanGate:true,blocked:false,reason:'PLATFORM_COMMIT_NOT_YET_AUTHORIZED',localAI:ai}});
 const packet=buildWorkPacket(job,opp,ai);
 updateJob(job.id,{status:'WORKPACK_READY',workPacket:{dir:packet.dir,kind:packet.kind}});
 setV('QA','WORKING',null,`QA ${job.id}`);const qa=qaWorkPacket(packet);if(!qa.pass){setV('QA','ERROR','WORKPACK_QA_FAIL',`QA fallo ${job.id}`);throw new Error('WORKPACK_QA_FAIL')};setV('QA','PASS',null,`QA PASS ${job.id}`);
 setV('EVIDENCE','WORKING',null,`Registrando ${job.id}`);const evidence=recordEvidence(packet,qa);setV('EVIDENCE','RECORDED',null,`Evidencia ${job.id}`);
 let browserState={connected:browserConnected,loginRequired:false,tabReady:false,error:null,tab:null};
 if(browserConnected){
  try{
   const tab=await ensurePlatformTab(opp.platformId,job.url,job.id);browserState.tab=tab;browserState.tabReady=true;
   const scan=await scanWorker(tab.workerId,20,1200).catch(()=>null);if(scan?.loginRequired)browserState.loginRequired=true;
  }catch(e){browserState.error=e.code||e.message;browserState.tabReady=false}
 }else browserState.error='EDGE_REMOTE_DEBUG_REQUIRED';
 const blocker=blockerFor(opp,browserState);
 let stage='READY_FOR_PLATFORM_ACTION';
 if(blocker==='EDGE_REMOTE_DEBUG_REQUIRED')stage='WAITING_EDGE_CONTROL';
 else if(blocker==='PLATFORM_LOGIN_REQUIRED')stage='WAITING_LOGIN';
 else if(blocker)stage='PLATFORM_READY_HUMAN_GATE';
 const updated=updateJob(job.id,{status:stage,blocker,qa:{pass:true,file:qa.file},evidence:[...(job.evidence||[]),evidence.file],concreted:false,earnedConfirmed:0,browser:{connected:browserState.connected,tabReady:browserState.tabReady,loginRequired:browserState.loginRequired,workerId:browserState.tab?.workerId||null,url:browserState.tab?.url||null}});
 const ledger=upsertLedger({job:updated,opportunity:opp,stage,status:stage,blocker,concreted:false,earnedConfirmed:0,note:blocker==='EDGE_REMOTE_DEBUG_REQUIRED'?'Trabajo preparado; falta habilitar control del Edge actual una sola vez.':blocker==='PLATFORM_LOGIN_REQUIRED'?'Pestaña abierta en el Edge actual; falta iniciar sesión.':blocker?'Pestaña lista en el Edge actual; falta Human Gate/confirmación de plataforma.':'Listo para acción permitida de plataforma.',qa:{pass:true,file:qa.file},evidence:{file:evidence.file}});
 const execState=stage==='WAITING_EDGE_CONTROL'?'WAITING_EDGE_CONTROL':stage==='WAITING_LOGIN'?'WAITING_LOGIN':stage==='PLATFORM_READY_HUMAN_GATE'?'WAITING_HUMAN_GATE':'READY_FOR_PLATFORM_ACTION';
 setV('EXECUTOR',execState,null,`${opp.platformId}: ${stage}`);return {job:updated,ledger,aiOk:!!ai.ok,qaPass:true,evidenceFile:evidence.file,browserState}
}
async function runWorkCycle(reason='AUTO'){
 if(paused)return {skipped:true,reason:'WORKERS_PAUSED'};if(cycleRunning)return {skipped:true,reason:'CYCLE_ALREADY_RUNNING'};
 cycleRunning=true;cycles++;lastCycle=nowIso();lastCycleError=null;activity('CYCLE_START',`Ciclo ${cycles} iniciado (${reason})`,{cycle:cycles,reason});
 try{
  setV('RADAR_PRO','WORKING',null,'Buscando trabajos PRO');setV('RADAR_MICRO','WORKING',null,'Buscando microtrabajos');
  const pub=testMode?syntheticPublic():await scanPublicAll();for(const r of pub.results||[])if(!r.error)mergeScan(r);
  setV('RADAR_PRO','READY',null,`Radar PRO actualizado ciclo ${cycles}`);setV('RADAR_MICRO','READY',null,`Radar MICRO actualizado ciclo ${cycles}`);
  let adopted=await adoptExistingPages().catch(()=>({connected:false,adopted:0,total:0}));let browserRepair=null;
  if(!testMode&&!adopted.connected&&settings.browserBridge?.autoRepairSameEdge&&Date.now()>=edgeRepairNotBefore){
    activity('BROWSER_REPAIR_AUTO','Autopilot detectó Edge sin control; evaluando reparación controlada');
    const rr=await repairExistingEdge((type,msg)=>activity(type,msg)).catch(e=>({repair:{ok:false,reason:e.message},hub:null}));browserRepair=rr?.repair||null;
    if(rr?.hub)adopted=await adoptExistingPages().catch(()=>({connected:true,adopted:0,total:0}));
  }
  const browserScans=adopted.connected?await mergeBrowserScans():[];
  setV('ANALYZER','WORKING',null,'Priorizando oportunidades');
  const candidates=listOpportunities({limit:Math.max(10,Number(settings.autopilot?.maxAnalyzePerCycle||3)*5)}).filter(x=>!String(x.lane||'').startsWith('REJECT'));
  const top=candidates.slice(0,Math.max(1,Number(settings.autopilot?.maxAnalyzePerCycle||3)));const analyses=[];for(const opp of top){const r=await analyzeOpportunityAI(opp);analyses.push({opportunityId:opp.id,...r})}
  setV('ANALYZER','READY',null,`Analizadas ${top.length} oportunidades`);
  const prepared=[];const maxPrepare=Math.max(1,Number(settings.autopilot?.maxPreparePerCycle||2));for(const opp of top.slice(0,maxPrepare))prepared.push(await prepareOne(opp,!!adopted.connected));
  if(!prepared.length){setV('EXECUTOR','WAITING_COMPATIBLE_TASK',null,'No hubo trabajo elegible');setV('QA','READY',null,'Sin paquete para QA');setV('EVIDENCE','READY',null,'Sin evidencia nueva')}
  const result={at:nowIso(),reason,cycle:cycles,publicRadarResults:(pub.results||[]).length,publicCandidates:(pub.results||[]).reduce((n,r)=>n+(r.candidates?.length||0),0),browserConnected:!!adopted.connected,browserRepair,adoptedTabs:adopted.total||0,browserScans:browserScans.length,opportunities:opportunityStats(),jobs:jobStats(),ledger:ledgerStats(),prepared:prepared.map(x=>({jobId:x.job.id,platformId:x.job.platformId,status:x.job.status,blocker:x.job.blocker,qaPass:x.qaPass})),localAI:await detectLocalAI(),aiAnalyzed:analyses.length,openedEdgeWindows:0,managedSameEdgeTabs:hubStatus().tabCount};lastCycleResult=result;activity('CYCLE_DONE',`Ciclo ${cycles} finalizado: ${result.opportunities?.total||0} oportunidades / ${result.ledger?.total||0} ledger`,{cycle:cycles});return result
 }catch(e){lastCycleError=e.message;activity('CYCLE_ERROR',`Ciclo ${cycles} error: ${e.message}`,{cycle:cycles,error:e.message});for(const id of ['RADAR_PRO','RADAR_MICRO','ANALYZER','EXECUTOR'])if(virtualWorkers[id].state==='WORKING')setV(id,'ERROR',e.message,'Error de ciclo');throw e}finally{cycleRunning=false}
}
async function prepareBest(){const opp=listOpportunities({limit:100}).find(x=>!String(x.lane||'').startsWith('REJECT'));if(!opp)throw new Error('NO_OPPORTUNITY');const adopted=await adoptExistingPages().catch(()=>({connected:false}));return await prepareOne(opp,!!adopted.connected)}
async function connectBrowserForCurrent(){
 activity('BROWSER_CONNECT','Intentando conectar al mismo Edge');
 let h=await connectExistingEdge();
 let repair=null;
 if(!h&&settings.browserBridge?.autoRepairSameEdge){
   activity('BROWSER_REPAIR','CDP no disponible; iniciando autorreparación controlada del mismo Edge');
   const rr=await repairExistingEdge((type,msg)=>activity(type,msg));repair=rr?.repair||null;h=rr?.hub||null;
 }
 if(!h){const diag=await diagnoseExistingEdge().catch(()=>null);activity('BROWSER_WAIT','Mismo Edge aún sin control',{diag});return {connected:false,needsOneTimeEnable:true,repair,diag,instructions:'V34 intentó autorreparación controlada. Si Edge no publica DevTools, revisar panel ACTIVIDAD EN VIVO.'}}
 const adopted=await adoptExistingPages();activity('BROWSER_CONNECTED',`Mismo Edge conectado; tabs adoptadas ${adopted.total||0}`,{source:hubStatus().endpointSource});
 const current=listLedger({limit:1})[0]||null;if(current?.platformId){try{const tab=await ensurePlatformTab(current.platformId,current.url,current.jobId||current.id);activity('BROWSER_TAB',`${current.platformId}: ${tab.reused?'pestaña reutilizada':'pestaña de trabajo abierta en mismo Edge'}`);return {connected:true,repair,adopted,tab}}catch(e){activity('BROWSER_TAB_ERROR',e.code||e.message);return {connected:true,repair,adopted,error:e.code||e.message}}}return {connected:true,repair,adopted}}

async function executeRelay(c){const cmd=String(c.command||'idle');if(cmd==='idle')return {ok:true};if(cmd==='pause_workers'){paused=true;return {paused:true}}if(cmd==='resume_workers'){paused=false;return await runWorkCycle('RELAY_RESUME')}if(cmd==='work_cycle'||cmd==='scan_all')return await runWorkCycle('RELAY');if(cmd==='prepare_best')return await prepareBest();if(cmd==='repair'){return {ok:true,browser:await adoptExistingPages().catch(()=>({connected:false}))}}throw new Error('RELAY_COMMAND_NOT_SUPPORTED')}
function status(){const browser=hubStatus(),radar=publicRadarStatus(),jobs=jobStats(),opp=opportunityStats(),ledger=ledgerStats(),v=Object.values(virtualWorkers);return {service:'duo-workers',version:'34.0.0',mode:settings.mode,sidecar:{host:settings.host,port},core,lastCoreProbe,workers:{enabled:v.filter(x=>x.enabled).length,total:v.length,busy:v.filter(x=>x.state==='WORKING').length,items:v},browser:{...browser,rule:'USE_SAME_RUNNING_EDGE_SINGLETON_NO_NEW_WINDOWS'},browserWorkers:listWorkers(),radar,opportunities:opp,jobs,ledger,currentWork:ledger.items?.[0]||null,autopilot:{enabled:!!settings.autopilot?.enabled,paused,running:cycleRunning,cycles,lastCycle,lastResult:lastCycleResult,lastError:lastCycleError},localAI:null,relay:relayStatus(),earnings:{confirmed:ledger.earnedConfirmed,currency:ledger.currency,note:'Only confirmed platform earnings are counted.'},activity:recentActivity(18),at:nowIso()}}
function html(){return '<!doctype html><html><head><meta charset="utf-8"><title>DUO V34</title></head><body><h1>DUO Work Center V34</h1><p>Use el panel nativo. API: /api/status</p></body></html>'}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host||settings.host}`);if(req.method==='GET'&&u.pathname==='/')return send(res,200,html(),'text/html; charset=utf-8');if(req.method==='GET'&&u.pathname==='/api/health')return send(res,200,{ok:true,service:'duo-workers',version:'34.0.0',port,paused,cycleRunning,browser:hubStatus(),at:nowIso()});if(req.method==='GET'&&u.pathname==='/api/status')return send(res,200,status());if(req.method==='GET'&&u.pathname==='/api/opportunities')return send(res,200,{items:listOpportunities({limit:200}),stats:opportunityStats()});if(req.method==='GET'&&u.pathname==='/api/jobs')return send(res,200,{items:listJobs({limit:100}),stats:jobStats()});if(req.method==='GET'&&u.pathname==='/api/ledger')return send(res,200,{items:listLedger({limit:100}),stats:ledgerStats()});if(req.method==='POST'&&!authed(req))return send(res,403,{error:'FORBIDDEN'});if(req.method==='POST'&&u.pathname==='/api/control/work-cycle'){runWorkCycle('PANEL').catch(()=>{});return send(res,202,{accepted:true,running:true})}if(req.method==='POST'&&u.pathname==='/api/control/pause'){paused=true;return send(res,200,{paused:true})}if(req.method==='POST'&&u.pathname==='/api/control/resume'){paused=false;runWorkCycle('PANEL_RESUME').catch(()=>{});return send(res,200,{paused:false,running:true})}if(req.method==='POST'&&u.pathname==='/api/browser/connect-current')return send(res,200,await connectBrowserForCurrent());if(req.method==='GET'&&u.pathname==='/api/browser/diagnose')return send(res,200,await diagnoseExistingEdge());if(req.method==='POST'&&u.pathname==='/api/browser/repair')return send(res,200,await repairExistingEdge((type,msg)=>activity(type,msg)));if(req.method==='POST'&&u.pathname==='/api/opportunities/reset')return send(res,200,resetOpportunities());if(req.method==='POST'&&u.pathname==='/api/jobs/prepare-best')return send(res,200,await prepareBest());return send(res,404,{error:'NOT_FOUND'})}catch(e){return send(res,500,{error:e.message})}});
server.listen(port,settings.host,()=>{activity('RUNTIME_START',`DUO WORKERS V34 ONLINE puerto ${port}`);console.log(`DUO WORKERS V34 ONLINE http://${settings.host}:${port}`);refreshCore().catch(()=>{});setTimeout(()=>runWorkCycle('STARTUP').catch(()=>{}),1200)});
if(!testMode)startRelay({settings,statePath,onCommand:executeRelay});
setInterval(()=>refreshCore().catch(()=>{}),10000).unref();
setInterval(()=>{if(settings.autopilot?.enabled&&!paused)runWorkCycle('AUTO').catch(()=>{})},Math.max(60,Number(settings.autopilot?.cycleEverySec||120))*1000).unref();
setInterval(()=>{try{fs.writeFileSync(statePath('workers-v34-heartbeat.json'),JSON.stringify({at:nowIso(),pid:process.pid,port,paused,cycleRunning,cycles,browser:hubStatus()},null,2),'utf8')}catch{}},5000).unref();
