const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'data.json');
const sessions = new Map();
const loginAttempts = new Map(); // ip -> {count, resetAt}

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newSalt(){ return crypto.randomBytes(16).toString('hex'); }
function id(prefix){ return prefix + '_' + crypto.randomBytes(6).toString('hex'); }
function now(){ return new Date().toISOString(); }
function tooManyAttempts(ip){
  const rec=loginAttempts.get(ip);
  const t=Date.now();
  if(!rec || t>rec.resetAt){ loginAttempts.set(ip,{count:1,resetAt:t+15*60*1000}); return false; }
  rec.count++;
  return rec.count>10;
}
function seed(){
  if (fs.existsSync(DB_FILE)) return;
  const homeownerId = 'usr_homeowner_demo';
  const providerId = 'usr_provider_demo';
  const provider2Id = 'usr_provider_demo2';
  const reqId = 'req_demo_sink';
  const homeownerSalt=newSalt(), providerSalt=newSalt(), provider2Salt=newSalt();
  const db = {
    users:[
      {id:homeownerId,role:'homeowner',name:'Jamie Carter',email:'homeowner@livingcommunities.test',salt:homeownerSalt,passwordHash:hash('Homeowner123!',homeownerSalt),phone:'214-555-0184',address:'Richardson, TX',community:'Richardson Community',subscription:'free',createdAt:now()},
      {id:providerId,role:'provider',name:'Richardson Pro Plumbing',email:'provider@livingcommunities.test',salt:providerSalt,passwordHash:hash('Provider123!',providerSalt),phone:'214-555-0127',serviceTypes:['Plumbing','Handyman'],rating:4.9,reviewCount:86,verified:true,subscription:'pro',businessDescription:'Licensed local plumbing and home-repair provider serving Richardson and nearby communities.',createdAt:now()},
      {id:provider2Id,role:'provider',name:'North Texas Home Pro',email:'provider2@livingcommunities.test',salt:provider2Salt,passwordHash:hash('Provider123!',provider2Salt),phone:'214-555-0199',serviceTypes:['Handyman','Lawn & Landscaping'],rating:4.7,reviewCount:54,verified:true,subscription:'pro',businessDescription:'General home services with flexible scheduling.',createdAt:now()}
    ],
    requests:[{id:reqId,homeownerId,serviceType:'Plumbing',title:'Kitchen sink leak',description:'Kitchen sink is leaking underneath the cabinet. Photos available.',urgency:'This week',preferredDate:'2026-08-27',preferredTime:'Afternoon',status:'open',createdAt:now()}],
    quotes:[
      {id:'quote_demo_1',requestId:reqId,providerId:providerId,amountMin:185,amountMax:250,availability:'Thursday · 2–4 PM',message:'I can take a look Thursday afternoon. I have handled similar sink leaks and can provide the final price after inspection.',status:'pending',createdAt:now()},
      {id:'quote_demo_2',requestId:reqId,providerId:provider2Id,amountMin:175,amountMax:300,availability:'This week · Flexible',message:'Happy to inspect and provide a firm quote.',status:'pending',createdAt:now()}
    ],
    messages:[],
    jobs:[],
    reviews:[],
    subscriptions:[]
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2));
}
function db(){ seed(); return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
function save(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2)); }
function send(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c; if(s.length>1e6){reject(new Error('Payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}})})}
function auth(req){ const t=(req.headers.authorization||'').replace('Bearer ',''); return sessions.get(t); }
function safeUser(u){if(!u)return null;const {passwordHash,salt,...x}=u; return x;}
// requireAuth resolves the full user record (not just the session id) so every
// downstream u.id / u.role reference below is safe to use.
function requireAuth(req,res,roles){
  const uid=auth(req);
  if(!uid){send(res,401,{error:'Authentication required'});return null}
  const data=db();
  const u=data.users.find(x=>x.id===uid);
  if(!u){sessions.delete((req.headers.authorization||'').replace('Bearer ',''));send(res,401,{error:'Session invalid'});return null}
  if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorized'});return null}
  return u;
}
function findProvider(data,id){return data.users.find(u=>u.id===id && u.role==='provider');}

const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
function serveStatic(req,res,pathname){
  let rel=pathname==='/'?'/index.html':pathname;
  const filePath=path.normalize(path.join(ROOT,rel));
  if(!filePath.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(filePath,(err,content)=>{
    if(err){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not found');}
    const ext=path.extname(filePath);
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(content);
  });
}

seed();
const server=http.createServer(async (req,res)=>{
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS'});return res.end();}
    const url=new URL(req.url,`http://${req.headers.host}`); const p=url.pathname;
    if(!p.startsWith('/api/') && req.method==='GET') return serveStatic(req,res,p);
    if(p==='/api/health') return send(res,200,{ok:true,service:'Living Communities API',time:now()});
    if(p==='/api/auth/login' && req.method==='POST'){
      const ip=req.socket.remoteAddress||'unknown';
      if(tooManyAttempts(ip)) return send(res,429,{error:'Too many attempts. Try again later.'});
      const b=await body(req), data=db(), u=data.users.find(x=>x.email.toLowerCase()===String(b.email||'').toLowerCase());
      if(!u || u.passwordHash!==hash(String(b.password||''),u.salt)) return send(res,401,{error:'Invalid email or password'});
      const token=crypto.randomBytes(24).toString('hex'); sessions.set(token,u.id); return send(res,200,{token,user:safeUser(u)});
    }
    if(p==='/api/auth/me' && req.method==='GET'){
      const u=requireAuth(req,res); if(!u)return; return send(res,200,{user:safeUser(u)});
    }
    if(p==='/api/auth/logout' && req.method==='POST'){const t=(req.headers.authorization||'').replace('Bearer ','');sessions.delete(t);return send(res,200,{ok:true});}

    const u=requireAuth(req,res); if(!u)return;
    const data=db();
    if(p==='/api/dashboard' && req.method==='GET'){
      if(u.role==='homeowner'){
        const requests=data.requests.filter(r=>r.homeownerId===u.id).map(r=>({...r,quotes:data.quotes.filter(q=>q.requestId===r.id).map(q=>({...q,provider:safeUser(findProvider(data,q.providerId))}))}));
        return send(res,200,{user:safeUser(data.users.find(x=>x.id===u.id)),requests,messages:data.messages.filter(m=>m.participants?.includes(u.id)),jobs:data.jobs.filter(j=>j.homeownerId===u.id),reviews:data.reviews.filter(r=>r.homeownerId===u.id)});
      }
      const requests=data.requests.filter(r=>r.status==='open').map(r=>({...r,quote:data.quotes.find(q=>q.requestId===r.id&&q.providerId===u.id)||null}));
      return send(res,200,{user:safeUser(data.users.find(x=>x.id===u.id)),requests,messages:data.messages.filter(m=>m.participants?.includes(u.id)),jobs:data.jobs.filter(j=>j.providerId===u.id),reviews:data.reviews.filter(r=>r.providerId===u.id)});
    }
    if(p==='/api/requests' && req.method==='GET'){
      const requests=u.role==='homeowner'?data.requests.filter(r=>r.homeownerId===u.id):data.requests.filter(r=>r.status==='open');
      return send(res,200,{requests});
    }
    if(p==='/api/requests' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can create requests'});
      const b=await body(req); const r={id:id('req'),homeownerId:u.id,serviceType:b.serviceType||'Handyman',title:String(b.title||`${b.serviceType||'Home'} service request`).slice(0,120),description:String(b.description||'').slice(0,2000),urgency:b.urgency||'Flexible',preferredDate:b.preferredDate||'',preferredTime:b.preferredTime||'Any time',status:'open',createdAt:now()}; data.requests.unshift(r);save(data);return send(res,201,{request:r});
    }
    if(p.startsWith('/api/requests/') && p.endsWith('/quotes') && req.method==='GET'){
      const rid=p.split('/')[3], r=data.requests.find(x=>x.id===rid); if(!r)return send(res,404,{error:'Request not found'});
      if(u.role==='homeowner'&&r.homeownerId!==u.id)return send(res,403,{error:'Not authorized'});
      const quotes=data.quotes.filter(q=>q.requestId===rid).map(q=>({...q,provider:safeUser(findProvider(data,q.providerId))}));return send(res,200,{quotes});
    }
    if(p.startsWith('/api/requests/') && p.endsWith('/quotes') && req.method==='POST'){
      if(u.role!=='provider')return send(res,403,{error:'Only providers can submit quotes'});
      const rid=p.split('/')[3], r=data.requests.find(x=>x.id===rid);if(!r)return send(res,404,{error:'Request not found'});
      if(data.quotes.some(q=>q.requestId===rid&&q.providerId===u.id))return send(res,409,{error:'You already responded to this request'});
      const b=await body(req), q={id:id('quote'),requestId:rid,providerId:u.id,amountMin:Number(b.amountMin||0),amountMax:Number(b.amountMax||0),availability:String(b.availability||'Flexible').slice(0,120),message:String(b.message||'').slice(0,1000),status:'pending',createdAt:now()};data.quotes.push(q);save(data);return send(res,201,{quote:q});
    }
    if(p.startsWith('/api/quotes/') && p.endsWith('/accept') && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can accept quotes'});
      const qid=p.split('/')[3],q=data.quotes.find(x=>x.id===qid);if(!q)return send(res,404,{error:'Quote not found'});const r=data.requests.find(x=>x.id===q.requestId);if(!r||r.homeownerId!==u.id)return send(res,403,{error:'Not authorized'});
      data.quotes.filter(x=>x.requestId===r.id).forEach(x=>x.status=x.id===q.id?'accepted':'declined');r.status='scheduled';const job={id:id('job'),requestId:r.id,homeownerId:u.id,providerId:q.providerId,serviceType:r.serviceType,title:r.title,status:'scheduled',scheduledFor:q.availability,createdAt:now()};data.jobs.push(job);save(data);return send(res,200,{request:r,job});
    }
    if(p==='/api/messages' && req.method==='GET'){
      const other=url.searchParams.get('with');const msgs=data.messages.filter(m=>m.participants?.includes(u.id)&&(other?m.participants.includes(other):true));return send(res,200,{messages:msgs});
    }
    if(p==='/api/messages' && req.method==='POST'){
      const b=await body(req), recipient=b.recipientId;const recipientUser=data.users.find(x=>x.id===recipient);if(!recipientUser)return send(res,404,{error:'Recipient not found'});const text=String(b.body||'').trim().slice(0,2000);if(!text)return send(res,400,{error:'Message cannot be empty'});const m={id:id('msg'),senderId:u.id,recipientId:recipient,participants:[u.id,recipient],body:text,createdAt:now(),read:false};data.messages.push(m);save(data);return send(res,201,{message:m});
    }
    if(p.startsWith('/api/jobs/') && req.method==='PATCH'){
      const jid=p.split('/')[3],job=data.jobs.find(x=>x.id===jid);if(!job)return send(res,404,{error:'Job not found'});if(job.homeownerId!==u.id&&job.providerId!==u.id)return send(res,403,{error:'Not authorized'});const b=await body(req);if(['scheduled','in_progress','completed','cancelled'].includes(b.status))job.status=b.status;save(data);return send(res,200,{job});
    }
    if(p==='/api/reviews' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can leave reviews'});const b=await body(req),job=data.jobs.find(j=>j.id===b.jobId&&j.homeownerId===u.id&&j.status==='completed');if(!job)return send(res,400,{error:'Job must be completed before reviewing'});if(data.reviews.some(r=>r.jobId===job.id))return send(res,409,{error:'Job already reviewed'});const review={id:id('review'),jobId:job.id,homeownerId:u.id,providerId:job.providerId,rating:Math.max(1,Math.min(5,Number(b.rating||5))),text:String(b.text||''),createdAt:now()};data.reviews.push(review);const provider=findProvider(data,job.providerId);const reviews=data.reviews.filter(r=>r.providerId===provider.id);provider.reviewCount=reviews.length;provider.rating=Math.round((reviews.reduce((a,r)=>a+r.rating,0)/reviews.length)*10)/10;save(data);return send(res,201,{review});
    }
    if(p==='/api/subscription' && req.method==='POST'){
      const b=await body(req);if(!['free','plus','pro'].includes(b.plan))return send(res,400,{error:'Invalid plan'});const user=data.users.find(x=>x.id===u.id);user.subscription=b.plan;data.subscriptions.push({id:id('sub'),userId:u.id,plan:b.plan,status:'active',createdAt:now()});save(data);return send(res,200,{subscription:b.plan,user:safeUser(user)});
    }
    if(p==='/api/providers' && req.method==='GET'){
      return send(res,200,{providers:data.users.filter(x=>x.role==='provider').map(safeUser)});
    }
    return send(res,404,{error:'Not found'});
  }catch(e){console.error(e);send(res,500,{error:'Server error',detail:e.message});}
});

server.listen(PORT,()=>console.log(`Living Communities API running at http://localhost:${PORT}`));
