const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// --- tiny .env loader (local dev convenience only; Render/Railway inject real env vars) ---
(function loadDotEnv(){
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = (m[2] || '').trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ROOT = __dirname;
const sessions = new Map(); // token -> userId  (in-memory; sessions reset on restart, fine for MVP)
const loginAttempts = new Map(); // ip -> {count, resetAt}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in (see README).');
  process.exit(1);
}
const useSSL = /sslmode=require/.test(process.env.DATABASE_URL) || process.env.PGSSL === 'true';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});
async function q(text, params) { return (await pool.query(text, params)).rows; }
async function q1(text, params) { return (await q(text, params))[0] || null; }

function hash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function newSalt(){ return crypto.randomBytes(16).toString('hex'); }
function id(prefix){ return prefix + '_' + crypto.randomBytes(6).toString('hex'); }
function now(){ return new Date(); }
function toISO(d){ return d instanceof Date ? d.toISOString() : d; }
function tooManyAttempts(ip){
  const rec=loginAttempts.get(ip);
  const t=Date.now();
  if(!rec || t>rec.resetAt){ loginAttempts.set(ip,{count:1,resetAt:t+15*60*1000}); return false; }
  rec.count++;
  return rec.count>10;
}

// --- row -> API-shape mappers (DB stays snake_case; the frontend expects the original camelCase shape) ---
function mapUser(r){
  if(!r) return null;
  const u={id:r.id,role:r.role,name:r.name,email:r.email,passwordHash:r.password_hash,salt:r.salt,phone:r.phone,createdAt:toISO(r.created_at),subscription:r.subscription};
  if(r.role==='homeowner'){ u.address=r.address; u.community=r.community; }
  else { u.serviceTypes=r.service_types||[]; u.rating=r.rating!=null?Number(r.rating):null; u.reviewCount=r.review_count||0; u.verified=!!r.verified; u.businessDescription=r.business_description; }
  return u;
}
function mapRequest(r){ return {id:r.id,homeownerId:r.homeowner_id,serviceType:r.service_type,title:r.title,description:r.description,urgency:r.urgency,preferredDate:r.preferred_date,preferredTime:r.preferred_time,status:r.status,createdAt:toISO(r.created_at)}; }
function mapQuote(r){ return {id:r.id,requestId:r.request_id,providerId:r.provider_id,amountMin:Number(r.amount_min),amountMax:Number(r.amount_max),availability:r.availability,message:r.message,status:r.status,createdAt:toISO(r.created_at)}; }
function mapMessage(r){ return {id:r.id,senderId:r.sender_id,recipientId:r.recipient_id,participants:r.participants,body:r.body,createdAt:toISO(r.created_at),read:r.read}; }
function mapJob(r){ return {id:r.id,requestId:r.request_id,homeownerId:r.homeowner_id,providerId:r.provider_id,serviceType:r.service_type,title:r.title,status:r.status,scheduledFor:r.scheduled_for,createdAt:toISO(r.created_at)}; }
function mapReview(r){ return {id:r.id,jobId:r.job_id,homeownerId:r.homeowner_id,providerId:r.provider_id,rating:Number(r.rating),text:r.text,createdAt:toISO(r.created_at)}; }
function safeUser(u){ if(!u) return null; const {passwordHash,salt,...x}=u; return x; }

async function initSchema(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      role text NOT NULL,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      salt text NOT NULL,
      phone text,
      address text,
      community text,
      service_types text[],
      rating numeric,
      review_count integer DEFAULT 0,
      verified boolean DEFAULT false,
      subscription text DEFAULT 'free',
      business_description text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS requests (
      id text PRIMARY KEY,
      homeowner_id text NOT NULL REFERENCES users(id),
      service_type text NOT NULL,
      title text NOT NULL,
      description text,
      urgency text,
      preferred_date text,
      preferred_time text,
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id text PRIMARY KEY,
      request_id text NOT NULL REFERENCES requests(id),
      provider_id text NOT NULL REFERENCES users(id),
      amount_min integer,
      amount_max integer,
      availability text,
      message text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY,
      sender_id text NOT NULL REFERENCES users(id),
      recipient_id text NOT NULL REFERENCES users(id),
      participants text[] NOT NULL,
      body text NOT NULL,
      read boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      request_id text NOT NULL REFERENCES requests(id),
      homeowner_id text NOT NULL REFERENCES users(id),
      provider_id text NOT NULL REFERENCES users(id),
      service_type text,
      title text,
      status text NOT NULL DEFAULT 'scheduled',
      scheduled_for text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES jobs(id),
      homeowner_id text NOT NULL REFERENCES users(id),
      provider_id text NOT NULL REFERENCES users(id),
      rating integer NOT NULL,
      text text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      plan text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_requests_homeowner ON requests(homeowner_id);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_provider ON quotes(provider_id);
    CREATE INDEX IF NOT EXISTS idx_messages_participants ON messages USING gin(participants);
    CREATE INDEX IF NOT EXISTS idx_jobs_homeowner ON jobs(homeowner_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider_id);
  `);
}
async function seedIfEmpty(){
  const {rows} = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const homeownerId='usr_homeowner_demo', providerId='usr_provider_demo', provider2Id='usr_provider_demo2', reqId='req_demo_sink';
  const hSalt=newSalt(), pSalt=newSalt(), p2Salt=newSalt();
  await pool.query('INSERT INTO users (id,role,name,email,password_hash,salt,phone,address,community,subscription) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [homeownerId,'homeowner','Jamie Carter','homeowner@livingcommunities.test',hash('Homeowner123!',hSalt),hSalt,'214-555-0184','Richardson, TX','Richardson Community','free']);
  await pool.query('INSERT INTO users (id,role,name,email,password_hash,salt,phone,service_types,rating,review_count,verified,subscription,business_description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [providerId,'provider','Richardson Pro Plumbing','provider@livingcommunities.test',hash('Provider123!',pSalt),pSalt,'214-555-0127',['Plumbing','Handyman'],4.9,86,true,'pro','Licensed local plumbing and home-repair provider serving Richardson and nearby communities.']);
  await pool.query('INSERT INTO users (id,role,name,email,password_hash,salt,phone,service_types,rating,review_count,verified,subscription,business_description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [provider2Id,'provider','North Texas Home Pro','provider2@livingcommunities.test',hash('Provider123!',p2Salt),p2Salt,'214-555-0199',['Handyman','Lawn & Landscaping'],4.7,54,true,'pro','General home services with flexible scheduling.']);
  await pool.query('INSERT INTO requests (id,homeowner_id,service_type,title,description,urgency,preferred_date,preferred_time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [reqId,homeownerId,'Plumbing','Kitchen sink leak','Kitchen sink is leaking underneath the cabinet. Photos available.','This week','2026-08-27','Afternoon','open']);
  await pool.query('INSERT INTO quotes (id,request_id,provider_id,amount_min,amount_max,availability,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    ['quote_demo_1',reqId,providerId,185,250,'Thursday · 2–4 PM','I can take a look Thursday afternoon. I have handled similar sink leaks and can provide the final price after inspection.','pending']);
  await pool.query('INSERT INTO quotes (id,request_id,provider_id,amount_min,amount_max,availability,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    ['quote_demo_2',reqId,provider2Id,175,300,'This week · Flexible','Happy to inspect and provide a firm quote.','pending']);
  console.log('Seeded demo data.');
}

function send(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c; if(s.length>1e6){reject(new Error('Payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}})})}
function authToken(req){ return (req.headers.authorization||'').replace('Bearer ',''); }
// requireAuth resolves the full user record from Postgres (not just the session id) so every
// downstream u.id / u.role reference below is safe to use.
async function requireAuth(req,res,roles){
  const token=authToken(req);
  const uid=sessions.get(token);
  if(!uid){send(res,401,{error:'Authentication required'});return null}
  const row=await q1('SELECT * FROM users WHERE id=$1',[uid]);
  if(!row){sessions.delete(token);send(res,401,{error:'Session invalid'});return null}
  const u=mapUser(row);
  if(roles&&!roles.includes(u.role)){send(res,403,{error:'Not authorized'});return null}
  return u;
}

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

// Loads quotes (with embedded provider) for a set of requests, keyed by request id.
async function quotesByRequestId(reqIds){
  if(!reqIds.length) return {};
  const quotes=await q('SELECT * FROM quotes WHERE request_id = ANY($1::text[]) ORDER BY created_at',[reqIds]);
  const providerIds=[...new Set(quotes.map(x=>x.provider_id))];
  const providers=providerIds.length?await q('SELECT * FROM users WHERE id = ANY($1::text[])',[providerIds]):[];
  const providerMap=Object.fromEntries(providers.map(p=>[p.id,safeUser(mapUser(p))]));
  const out={};
  for(const qq of quotes){ (out[qq.request_id]=out[qq.request_id]||[]).push({...mapQuote(qq),provider:providerMap[qq.provider_id]}); }
  return out;
}

const server=http.createServer(async (req,res)=>{
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS'});return res.end();}
    const url=new URL(req.url,`http://${req.headers.host}`); const p=url.pathname;
    if(!p.startsWith('/api/') && req.method==='GET') return serveStatic(req,res,p);
    if(p==='/api/health') return send(res,200,{ok:true,service:'Living Communities API',time:new Date().toISOString()});

    if(p==='/api/auth/login' && req.method==='POST'){
      const ip=req.socket.remoteAddress||'unknown';
      if(tooManyAttempts(ip)) return send(res,429,{error:'Too many attempts. Try again later.'});
      const b=await body(req);
      const row=await q1('SELECT * FROM users WHERE lower(email)=lower($1)',[String(b.email||'')]);
      const u=mapUser(row);
      if(!u || u.passwordHash!==hash(String(b.password||''),u.salt)) return send(res,401,{error:'Invalid email or password'});
      const token=crypto.randomBytes(24).toString('hex'); sessions.set(token,u.id); return send(res,200,{token,user:safeUser(u)});
    }
    if(p==='/api/auth/me' && req.method==='GET'){
      const u=await requireAuth(req,res); if(!u)return; return send(res,200,{user:safeUser(u)});
    }
    if(p==='/api/auth/logout' && req.method==='POST'){sessions.delete(authToken(req));return send(res,200,{ok:true});}

    const u=await requireAuth(req,res); if(!u)return;

    if(p==='/api/dashboard' && req.method==='GET'){
      if(u.role==='homeowner'){
        const reqRows=await q('SELECT * FROM requests WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]);
        const qMap=await quotesByRequestId(reqRows.map(r=>r.id));
        const requests=reqRows.map(r=>({...mapRequest(r),quotes:qMap[r.id]||[]}));
        const messages=await q('SELECT * FROM messages WHERE $1 = ANY(participants) ORDER BY created_at',[u.id]);
        const jobs=await q('SELECT * FROM jobs WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]);
        const reviews=await q('SELECT * FROM reviews WHERE homeowner_id=$1',[u.id]);
        return send(res,200,{user:safeUser(u),requests,messages:messages.map(mapMessage),jobs:jobs.map(mapJob),reviews:reviews.map(mapReview)});
      }
      const openRows=await q("SELECT * FROM requests WHERE status='open' ORDER BY created_at DESC");
      const myQuotes=openRows.length?await q('SELECT * FROM quotes WHERE request_id = ANY($1::text[]) AND provider_id=$2',[openRows.map(r=>r.id),u.id]):[];
      const quoteByReq=Object.fromEntries(myQuotes.map(qq=>[qq.request_id,mapQuote(qq)]));
      const requests=openRows.map(r=>({...mapRequest(r),quote:quoteByReq[r.id]||null}));
      const messages=await q('SELECT * FROM messages WHERE $1 = ANY(participants) ORDER BY created_at',[u.id]);
      const jobs=await q('SELECT * FROM jobs WHERE provider_id=$1 ORDER BY created_at DESC',[u.id]);
      const reviews=await q('SELECT * FROM reviews WHERE provider_id=$1',[u.id]);
      return send(res,200,{user:safeUser(u),requests,messages:messages.map(mapMessage),jobs:jobs.map(mapJob),reviews:reviews.map(mapReview)});
    }

    if(p==='/api/requests' && req.method==='GET'){
      const rows=u.role==='homeowner'?await q('SELECT * FROM requests WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]):await q("SELECT * FROM requests WHERE status='open' ORDER BY created_at DESC");
      return send(res,200,{requests:rows.map(mapRequest)});
    }
    if(p==='/api/requests' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can create requests'});
      const b=await body(req);
      const serviceType=b.serviceType||'Handyman';
      const row=await q1('INSERT INTO requests (id,homeowner_id,service_type,title,description,urgency,preferred_date,preferred_time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [id('req'),u.id,serviceType,String(b.title||`${serviceType} service request`).slice(0,120),String(b.description||'').slice(0,2000),b.urgency||'Flexible',b.preferredDate||'',b.preferredTime||'Any time','open']);
      return send(res,201,{request:mapRequest(row)});
    }
    if(p.startsWith('/api/requests/') && p.endsWith('/quotes') && req.method==='GET'){
      const rid=p.split('/')[3], r=await q1('SELECT * FROM requests WHERE id=$1',[rid]); if(!r)return send(res,404,{error:'Request not found'});
      if(u.role==='homeowner'&&r.homeowner_id!==u.id)return send(res,403,{error:'Not authorized'});
      const qMap=await quotesByRequestId([rid]);
      return send(res,200,{quotes:qMap[rid]||[]});
    }
    if(p.startsWith('/api/requests/') && p.endsWith('/quotes') && req.method==='POST'){
      if(u.role!=='provider')return send(res,403,{error:'Only providers can submit quotes'});
      const rid=p.split('/')[3], r=await q1('SELECT * FROM requests WHERE id=$1',[rid]); if(!r)return send(res,404,{error:'Request not found'});
      const existing=await q1('SELECT id FROM quotes WHERE request_id=$1 AND provider_id=$2',[rid,u.id]);
      if(existing)return send(res,409,{error:'You already responded to this request'});
      const b=await body(req);
      const row=await q1('INSERT INTO quotes (id,request_id,provider_id,amount_min,amount_max,availability,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id('quote'),rid,u.id,Number(b.amountMin||0),Number(b.amountMax||0),String(b.availability||'Flexible').slice(0,120),String(b.message||'').slice(0,1000),'pending']);
      return send(res,201,{quote:mapQuote(row)});
    }
    if(p.startsWith('/api/quotes/') && p.endsWith('/accept') && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can accept quotes'});
      const qid=p.split('/')[3];
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const qr=await client.query('SELECT * FROM quotes WHERE id=$1 FOR UPDATE',[qid]);
        const quote=qr.rows[0]; if(!quote){await client.query('ROLLBACK');return send(res,404,{error:'Quote not found'});}
        const rr=await client.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE',[quote.request_id]);
        const r=rr.rows[0];
        if(!r||r.homeowner_id!==u.id){await client.query('ROLLBACK');return send(res,403,{error:'Not authorized'});}
        await client.query("UPDATE quotes SET status='accepted' WHERE id=$1",[qid]);
        await client.query("UPDATE quotes SET status='declined' WHERE request_id=$1 AND id<>$2",[r.id,qid]);
        const updatedReq=(await client.query("UPDATE requests SET status='scheduled' WHERE id=$1 RETURNING *",[r.id])).rows[0];
        const job=(await client.query('INSERT INTO jobs (id,request_id,homeowner_id,provider_id,service_type,title,status,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [id('job'),r.id,u.id,quote.provider_id,r.service_type,r.title,'scheduled',quote.availability])).rows[0];
        await client.query('COMMIT');
        return send(res,200,{request:mapRequest(updatedReq),job:mapJob(job)});
      }catch(e){ await client.query('ROLLBACK'); throw e; }
      finally{ client.release(); }
    }
    if(p==='/api/messages' && req.method==='GET'){
      const other=url.searchParams.get('with');
      const rows=other
        ? await q('SELECT * FROM messages WHERE $1 = ANY(participants) AND $2 = ANY(participants) ORDER BY created_at',[u.id,other])
        : await q('SELECT * FROM messages WHERE $1 = ANY(participants) ORDER BY created_at',[u.id]);
      return send(res,200,{messages:rows.map(mapMessage)});
    }
    if(p==='/api/messages' && req.method==='POST'){
      const b=await body(req), recipient=b.recipientId;
      const recipientRow=await q1('SELECT id FROM users WHERE id=$1',[recipient]); if(!recipientRow)return send(res,404,{error:'Recipient not found'});
      const text=String(b.body||'').trim().slice(0,2000); if(!text)return send(res,400,{error:'Message cannot be empty'});
      const row=await q1('INSERT INTO messages (id,sender_id,recipient_id,participants,body,read) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [id('msg'),u.id,recipient,[u.id,recipient],text,false]);
      return send(res,201,{message:mapMessage(row)});
    }
    if(p.startsWith('/api/jobs/') && req.method==='PATCH'){
      const jid=p.split('/')[3], job=await q1('SELECT * FROM jobs WHERE id=$1',[jid]); if(!job)return send(res,404,{error:'Job not found'});
      if(job.homeowner_id!==u.id&&job.provider_id!==u.id)return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      let row=job;
      if(['scheduled','in_progress','completed','cancelled'].includes(b.status)){
        row=await q1('UPDATE jobs SET status=$1 WHERE id=$2 RETURNING *',[b.status,jid]);
      }
      return send(res,200,{job:mapJob(row)});
    }
    if(p==='/api/reviews' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can leave reviews'});
      const b=await body(req);
      const job=await q1("SELECT * FROM jobs WHERE id=$1 AND homeowner_id=$2 AND status='completed'",[b.jobId,u.id]);
      if(!job)return send(res,400,{error:'Job must be completed before reviewing'});
      const dupe=await q1('SELECT id FROM reviews WHERE job_id=$1',[job.id]); if(dupe)return send(res,409,{error:'Job already reviewed'});
      const rating=Math.max(1,Math.min(5,Number(b.rating||5)));
      const row=await q1('INSERT INTO reviews (id,job_id,homeowner_id,provider_id,rating,text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [id('review'),job.id,u.id,job.provider_id,rating,String(b.text||'').slice(0,2000)]);
      const agg=await q1('SELECT count(*)::int AS n, avg(rating) AS avg FROM reviews WHERE provider_id=$1',[job.provider_id]);
      await pool.query('UPDATE users SET review_count=$1, rating=$2 WHERE id=$3',[agg.n,Math.round(Number(agg.avg)*10)/10,job.provider_id]);
      return send(res,201,{review:mapReview(row)});
    }
    if(p==='/api/subscription' && req.method==='POST'){
      const b=await body(req); if(!['free','plus','pro'].includes(b.plan))return send(res,400,{error:'Invalid plan'});
      const row=await q1('UPDATE users SET subscription=$1 WHERE id=$2 RETURNING *',[b.plan,u.id]);
      await pool.query('INSERT INTO subscriptions (id,user_id,plan,status) VALUES ($1,$2,$3,$4)',[id('sub'),u.id,b.plan,'active']);
      return send(res,200,{subscription:b.plan,user:safeUser(mapUser(row))});
    }
    if(p==='/api/providers' && req.method==='GET'){
      const rows=await q("SELECT * FROM users WHERE role='provider' ORDER BY rating DESC NULLS LAST");
      return send(res,200,{providers:rows.map(r=>safeUser(mapUser(r)))});
    }
    return send(res,404,{error:'Not found'});
  }catch(e){console.error(e);send(res,500,{error:'Server error',detail:e.message});}
});

initSchema()
  .then(seedIfEmpty)
  .then(()=>{ server.listen(PORT,()=>console.log(`Living Communities API running at http://localhost:${PORT}`)); })
  .catch(e=>{ console.error('Failed to start (check DATABASE_URL):', e); process.exit(1); });
