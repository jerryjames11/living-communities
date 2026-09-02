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
  const u={id:r.id,role:r.role,name:r.name,email:r.email,passwordHash:r.password_hash,salt:r.salt,phone:r.phone,createdAt:toISO(r.created_at),subscription:r.subscription,carePlanServices:r.care_plan_services||[],avatarKind:r.avatar_kind||null,avatarValue:r.avatar_value||null};
  if(r.role==='homeowner'){ u.address=r.address; u.community=r.community; u.lat=r.lat!=null?Number(r.lat):null; u.lng=r.lng!=null?Number(r.lng):null; u.carePlanNextBilling=r.care_plan_next_billing?new Date(r.care_plan_next_billing).toISOString().slice(0,10):null; }
  else { u.serviceTypes=r.service_types||[]; u.rating=r.rating!=null?Number(r.rating):null; u.reviewCount=r.review_count||0; u.verified=!!r.verified; u.businessDescription=r.business_description; u.providerPlan=r.provider_plan||'free'; u.quotesUsed=r.quotes_sent_this_period||0; u.convosUsed=r.new_conversations_this_period||0; }
  return u;
}
function mapRequest(r){ return {id:r.id,homeownerId:r.homeowner_id,serviceType:r.service_type,title:r.title,description:r.description,urgency:r.urgency,preferredDate:r.preferred_date,preferredTime:r.preferred_time,status:r.status,createdAt:toISO(r.created_at)}; }
function mapQuote(r){ return {id:r.id,requestId:r.request_id,providerId:r.provider_id,amountMin:Number(r.amount_min),amountMax:Number(r.amount_max),availability:r.availability,message:r.message,status:r.status,createdAt:toISO(r.created_at)}; }
function mapMessage(r){ return {id:r.id,senderId:r.sender_id,recipientId:r.recipient_id,participants:r.participants,body:r.body,createdAt:toISO(r.created_at),read:r.read}; }
function mapJob(r){ return {id:r.id,requestId:r.request_id,homeownerId:r.homeowner_id,providerId:r.provider_id,serviceType:r.service_type,title:r.title,status:r.status,scheduledFor:r.scheduled_for,createdAt:toISO(r.created_at)}; }
function mapReview(r){ return {id:r.id,jobId:r.job_id,homeownerId:r.homeowner_id,providerId:r.provider_id,rating:Number(r.rating),text:r.text,createdAt:toISO(r.created_at)}; }
function safeUser(u){ if(!u) return null; const {passwordHash,salt,...x}=u; return x; }

// --- geocoding (Nominatim/OpenStreetMap — free, no API key; usage-policy limit ~1 req/sec, demo-scale only) ---
async function geocodeAddress(address){
  const addr=String(address||'').trim();
  if(!addr) return null;
  try{
    const url='https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(addr);
    const resp=await fetch(url,{headers:{'User-Agent':'LivingCommunitiesApp/1.0 (demo app; contact hello@livingcommunities.example)'}});
    if(!resp.ok) return null;
    const data=await resp.json();
    if(!Array.isArray(data)||!data.length) return null;
    const lat=Number(data[0].lat), lng=Number(data[0].lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)) return null;
    return {lat,lng};
  }catch(e){ console.error('geocode error:',e.message); return null; }
}
function haversineMiles(lat1,lon1,lat2,lon2){
  const R=3958.8; // earth radius, miles
  const toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.asin(Math.sqrt(a));
}

// --- email (Resend REST API — https://resend.com; no SDK dependency, just fetch) ---
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Living Communities <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:' + PORT;
const INTERNAL_JOB_KEY = process.env.INTERNAL_JOB_KEY || '';

// --- payments (Stripe REST API — https://stripe.com; no SDK dependency, just fetch) ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
function stripeConfigured(){ return !!STRIPE_SECRET_KEY; }
// $29/mo is a suggested default for the provider paywall plan — change freely, it's just a constant.
const PROVIDER_PLAN_PRICE_CENTS = 2900;
const PROVIDER_FREE_QUOTE_LIMIT = 3;
const PROVIDER_FREE_CONVO_LIMIT = 3;

// Flattens a nested object into Stripe's bracket-notation form encoding, e.g.
// {items:[{price_data:{unit_amount:100}}]} -> "items[0][price_data][unit_amount]=100"
function toStripeForm(obj){
  const parts=[];
  (function walk(o,p){
    if(o===undefined||o===null) return;
    if(Array.isArray(o)) o.forEach((v,i)=>walk(v,`${p}[${i}]`));
    else if(typeof o==='object') Object.keys(o).forEach(k=>walk(o[k], p?`${p}[${k}]`:k));
    else parts.push(encodeURIComponent(p)+'='+encodeURIComponent(o));
  })(obj,'');
  return parts.join('&');
}
async function stripeRequest(method, endpoint, params){
  const opts={method,headers:{'Authorization':'Bearer '+STRIPE_SECRET_KEY}};
  if(params){ opts.headers['Content-Type']='application/x-www-form-urlencoded'; opts.body=toStripeForm(params); }
  const resp=await fetch('https://api.stripe.com/v1/'+endpoint,opts);
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){ const err=new Error(data.error?.message||('Stripe request failed: '+resp.status)); err.stripeError=data.error; throw err; }
  return data;
}
// Sends a 402 for a declined/invalid card, 400 for other Stripe errors, or rethrows if it's not
// a Stripe error at all (so the outer server try/catch still turns it into a 500).
function sendStripeError(res,e){
  if(e && e.stripeError) return send(res, e.stripeError.type==='card_error'?402:400, {error:e.stripeError.message||'Payment failed'});
  throw e;
}
async function ensureStripeCustomer(u){
  const row=await q1('SELECT stripe_customer_id FROM users WHERE id=$1',[u.id]);
  if(row && row.stripe_customer_id) return row.stripe_customer_id;
  const customer=await stripeRequest('POST','customers',{email:u.email,name:u.name,metadata:{app_user_id:u.id}});
  await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2',[customer.id,u.id]);
  return customer.id;
}
// Attaches the payment method, sets it as the customer's default, cancels any prior subscription
// for this slot (community plan / care plan / provider plan each track their own), and creates a
// fresh subscription with one inline price_data item per line (no pre-created Price objects needed).
// This "cancel & recreate" approach keeps the integration simple; the tradeoff is that changing a
// plan resets that plan's billing-anchor date rather than prorating in place.
async function stripeSubscribe(customerId, paymentMethodId, existingSubId, items){
  await stripeRequest('POST','payment_methods/'+paymentMethodId+'/attach',{customer:customerId});
  await stripeRequest('POST','customers/'+customerId,{invoice_settings:{default_payment_method:paymentMethodId}});
  if(existingSubId) await stripeRequest('DELETE','subscriptions/'+existingSubId).catch(()=>{});
  const sub=await stripeRequest('POST','subscriptions',{
    customer:customerId,
    items:items.map(it=>({price_data:{currency:'usd',unit_amount:it.unitAmount,recurring:{interval:it.interval||'month'},product_data:{name:it.name}}})),
    default_payment_method:paymentMethodId,
  });
  return sub;
}
function verifyStripeSignature(rawBodyBuf, sigHeader, secret){
  if(!sigHeader) return false;
  const parts=Object.fromEntries(sigHeader.split(',').map(kv=>{const i=kv.indexOf('='); return [kv.slice(0,i),kv.slice(i+1)]}));
  if(!parts.t||!parts.v1) return false;
  const expected=crypto.createHmac('sha256',secret).update(parts.t+'.'+rawBodyBuf.toString('utf8')).digest('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(parts.v1,'hex')); }catch(e){ return false; }
}
// Lazily resets a provider's monthly quote/conversation counters the first time they're checked
// after the calendar month rolls over — no cron needed for this, unlike Home Care Plan billing.
async function ensureUsagePeriod(u){
  const periodStart=new Date(); periodStart.setUTCDate(1); periodStart.setUTCHours(0,0,0,0);
  const periodStr=periodStart.toISOString().slice(0,10);
  const row=await q1('SELECT usage_period_start,quotes_sent_this_period,new_conversations_this_period FROM users WHERE id=$1',[u.id]);
  const rowPeriod=row.usage_period_start?new Date(row.usage_period_start).toISOString().slice(0,10):null;
  if(rowPeriod!==periodStr){
    await pool.query('UPDATE users SET usage_period_start=$1, quotes_sent_this_period=0, new_conversations_this_period=0 WHERE id=$2',[periodStr,u.id]);
    return {quotes:0,convos:0};
  }
  return {quotes:row.quotes_sent_this_period||0,convos:row.new_conversations_this_period||0};
}

function emailShell(preheader, bodyHtml){
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#faf9f5;padding:32px 16px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e4e9e6;border-radius:16px;overflow:hidden">
    <div style="padding:22px 28px;border-bottom:1px solid #e4e9e6">
      <span style="font-weight:800;font-size:18px;color:#17352f">Living <span style="color:#286b58">Communities</span></span>
    </div>
    <div style="padding:28px">${bodyHtml}</div>
    <div style="padding:16px 28px;border-top:1px solid #e4e9e6;color:#6d7b77;font-size:11.5px">Living Communities · this is an automated message.</div>
  </div>
  <span style="display:none;max-height:0;overflow:hidden">${esc_(preheader)}</span>
</div>`;
}
function esc_(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function btn(label, href){ return `<a href="${href}" style="display:inline-block;background:#286b58;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin-top:8px">${esc_(label)}</a>`; }

async function sendEmail({to,type,subject,html,userId}){
  const logId=id('email');
  if(!RESEND_API_KEY){
    console.log(`[email:DRY RUN — no RESEND_API_KEY set] to=${to} type=${type} subject="${subject}"`);
    try{ await pool.query('INSERT INTO email_log (id,user_id,to_email,type,subject,status) VALUES ($1,$2,$3,$4,$5,$6)',[logId,userId||null,to,type,subject,'dry_run']); }catch(e){}
    return {ok:true,dryRun:true};
  }
  try{
    const resp=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:EMAIL_FROM,to:[to],subject,html})
    });
    if(!resp.ok){
      const errText=await resp.text();
      console.error('email send failed:',resp.status,errText);
      await pool.query('INSERT INTO email_log (id,user_id,to_email,type,subject,status,error) VALUES ($1,$2,$3,$4,$5,$6,$7)',[logId,userId||null,to,type,subject,'error',String(errText).slice(0,500)]);
      return {ok:false};
    }
    await pool.query('INSERT INTO email_log (id,user_id,to_email,type,subject,status) VALUES ($1,$2,$3,$4,$5,$6)',[logId,userId||null,to,type,subject,'sent']);
    return {ok:true};
  }catch(e){
    console.error('email send error:',e.message);
    try{ await pool.query('INSERT INTO email_log (id,user_id,to_email,type,subject,status,error) VALUES ($1,$2,$3,$4,$5,$6,$7)',[logId,userId||null,to,type,subject,'error',String(e.message).slice(0,500)]); }catch(e2){}
    return {ok:false};
  }
}

// Must match the icon ids defined client-side in AVATAR_ICONS (index.html) — kept here only as a
// server-side allowlist so an /api/profile/avatar call can't stash an arbitrary string.
const AVATAR_ICON_IDS=['h1','h2','h3','h4','h5','p1','p2','p3','p4','p5'];

const CARE_SERVICE_INFO={
  landscaping:{name:'Landscaping',price:89,billing:'mo'},
  pest:{name:'Pest Control',price:39,billing:'mo'},
  cleaning:{name:'Home Cleaning',price:129,billing:'mo'},
  pool:{name:'Pool Cleaning',price:99,billing:'mo'},
  holiday_lighting:{name:'Holiday Lighting',price:65,billing:'season'}
};
function carePlanMonthlyTotal(services){ return (services||[]).reduce((sum,k)=>{const s=CARE_SERVICE_INFO[k]; return s&&s.billing==='mo'?sum+s.price:sum},0); }
function fmtDate(d){ return new Date(d).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}); }

function welcomeEmailHtml(u){
  const isProvider=u.role==='provider';
  return emailShell('Welcome to Living Communities',
    `<h2 style="margin:0 0 10px;color:#17352f">Welcome, ${esc_(u.name.split(' ')[0])}!</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">${isProvider?"Your provider account is ready. Browse open requests and start sending quotes to local homeowners.":"Your account is ready. Post a request and local providers will start sending you quotes."}</p>
     ${btn(isProvider?'View Request Feed':'Go to My Dashboard',APP_URL)}`);
}
function newQuoteEmailHtml(homeowner,request,quote,provider){
  return emailShell('You received a new quote',
    `<h2 style="margin:0 0 10px;color:#17352f">New quote on "${esc_(request.title)}"</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(provider.name)}</b> sent a quote: <b>$${quote.amount_min}–$${quote.amount_max}</b>, available ${esc_(quote.availability||'flexible')}.</p>
     ${btn('View Quote',APP_URL)}`);
}
function quoteAcceptedEmailHtml(provider,request){
  return emailShell('Your quote was accepted',
    `<h2 style="margin:0 0 10px;color:#17352f">You got the job! 🎉</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your quote on "${esc_(request.title)}" was accepted. It's now on your Active Jobs list.</p>
     ${btn('View Job',APP_URL)}`);
}
function newMessageEmailHtml(recipientName,senderName,body){
  return emailShell('New message',
    `<h2 style="margin:0 0 10px;color:#17352f">New message from ${esc_(senderName)}</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#eaf4ef;border-radius:10px;padding:12px 14px">${esc_(body).slice(0,200)}</p>
     ${btn('Reply',APP_URL)}`);
}
function carePlanReminderEmailHtml(u,amount,billingDate){
  return emailShell('Your Home Care Plan renews soon',
    `<h2 style="margin:0 0 10px;color:#17352f">Your plan renews in 7 days</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your Home Care Plan will renew on <b>${fmtDate(billingDate)}</b> and your card on file will be charged <b>$${amount}</b>. No action needed — manage or cancel anytime from your dashboard.</p>
     ${btn('Manage My Plan',APP_URL)}`);
}
function carePlanBilledEmailHtml(u,amount,billingDate){
  return emailShell('Your card was charged',
    `<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged <b>$${amount}</b> for your Home Care Plan, renewing on ${fmtDate(billingDate)}. This is a demo charge — no real payment was processed.</p>
     ${btn('View Billing',APP_URL)}`);
}

// Simulated monthly billing for Home Care Plan: sends a reminder 7 days before the next_billing
// date, and a "card was charged" email (mock — no real payment) on/after that date, then rolls
// next_billing forward one month. Runs on an in-process interval AND via the internal HTTP
// endpoint above, since a free-tier host that spins down on idle can't be trusted to keep a
// setInterval alive — an external pinger hitting that endpoint is the reliable path there.
async function runBillingCheck(){
  const todayStr=new Date().toISOString().slice(0,10);
  const in7Str=new Date(Date.now()+7*24*60*60*1000).toISOString().slice(0,10);
  let reminders=0, charges=0;
  // Rows with a real Stripe subscription are billed by Stripe itself (see the webhook handler
  // below) — this simulated check only ever touches demo-mode (no Stripe key) subscribers.
  const rows=await q("SELECT * FROM users WHERE role='homeowner' AND care_plan_next_billing IS NOT NULL AND care_plan_stripe_subscription_id IS NULL");
  for(const r of rows){
    const services=r.care_plan_services||[];
    if(!services.length) continue;
    const nextBilling=new Date(r.care_plan_next_billing).toISOString().slice(0,10);
    const amount=carePlanMonthlyTotal(services);
    if(!amount) continue;
    const reminderSentFor=r.care_plan_reminder_sent_for?new Date(r.care_plan_reminder_sent_for).toISOString().slice(0,10):null;
    if(nextBilling===in7Str && reminderSentFor!==nextBilling){
      await sendEmail({to:r.email,type:'care_plan_reminder',subject:'Your Home Care Plan renews in 7 days',html:carePlanReminderEmailHtml(r,amount,nextBilling),userId:r.id});
      await pool.query('UPDATE users SET care_plan_reminder_sent_for=$1 WHERE id=$2',[nextBilling,r.id]);
      reminders++;
    }
    if(nextBilling<=todayStr){
      await sendEmail({to:r.email,type:'care_plan_billed',subject:'Your card was charged for your Home Care Plan',html:carePlanBilledEmailHtml(r,amount,nextBilling),userId:r.id});
      const newNext=new Date(nextBilling+'T00:00:00Z'); newNext.setUTCMonth(newNext.getUTCMonth()+1);
      await pool.query('UPDATE users SET care_plan_next_billing=$1, care_plan_reminder_sent_for=NULL WHERE id=$2',[newNext.toISOString().slice(0,10),r.id]);
      charges++;
    }
  }
  return {reminders,charges,checked:rows.length};
}

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
  // Migration-safe: adds columns/tables for databases whose schema predates these features.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_services text[] DEFAULT '{}'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lat double precision`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lng double precision`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS geocoded_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_next_billing date`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_reminder_sent_for date`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_stripe_subscription_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_plan text DEFAULT 'free'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_plan_stripe_subscription_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS quotes_sent_this_period integer DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS new_conversations_this_period integer DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_period_start date`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe_events (id text PRIMARY KEY, type text, created_at timestamptz DEFAULT now())`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_kind text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_value text`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      id text PRIMARY KEY,
      user_id text REFERENCES users(id),
      to_email text NOT NULL,
      type text NOT NULL,
      subject text NOT NULL,
      status text NOT NULL,
      error text,
      sent_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(user_id);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS neighborhood_posts (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      body text NOT NULL,
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_neighborhood_posts_created ON neighborhood_posts(created_at DESC);
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
// Raw (unparsed) body — needed for the Stripe webhook, whose signature is computed over the exact
// bytes Stripe sent, not a re-serialized JSON.parse/stringify round-trip of them.
function rawBody(req){return new Promise((resolve,reject)=>{const chunks=[];let len=0;req.on('data',c=>{chunks.push(c);len+=c.length; if(len>2e6){reject(new Error('Payload too large'));req.destroy();}});req.on('end',()=>resolve(Buffer.concat(chunks)))})}
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
    if(p==='/api/auth/register' && req.method==='POST'){
      const ip=req.socket.remoteAddress||'unknown';
      if(tooManyAttempts(ip+':register')) return send(res,429,{error:'Too many attempts. Try again later.'});
      const b=await body(req);
      const role=b.role==='provider'?'provider':'homeowner';
      const name=String(b.name||'').trim().slice(0,120);
      const email=String(b.email||'').trim().toLowerCase().slice(0,200);
      const password=String(b.password||'');
      if(!name) return send(res,400,{error:'Name is required'});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res,400,{error:'A valid email is required'});
      if(password.length<8) return send(res,400,{error:'Password must be at least 8 characters'});
      const existing=await q1('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
      if(existing) return send(res,409,{error:'An account with this email already exists'});
      const salt=newSalt();
      const phone=String(b.phone||'').trim().slice(0,40);
      const uid=id('usr');
      let row;
      if(role==='homeowner'){
        const address=String(b.address||'').trim().slice(0,200);
        row=await q1('INSERT INTO users (id,role,name,email,password_hash,salt,phone,address,community,subscription) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [uid,'homeowner',name,email,hash(password,salt),salt,phone,address,String(b.community||'').trim().slice(0,120),'free']);
        if(address){
          const geo=await geocodeAddress(address);
          if(geo) row=await q1('UPDATE users SET lat=$1,lng=$2,geocoded_at=now() WHERE id=$3 RETURNING *',[geo.lat,geo.lng,uid]);
        }
      }else{
        const serviceTypes=Array.isArray(b.serviceTypes)?b.serviceTypes.map(s=>String(s).trim()).filter(Boolean).slice(0,10):[];
        row=await q1('INSERT INTO users (id,role,name,email,password_hash,salt,phone,service_types,rating,review_count,verified,subscription,business_description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
          [uid,'provider',name,email,hash(password,salt),salt,phone,serviceTypes,null,0,false,'free',String(b.businessDescription||'').trim().slice(0,1000)]);
      }
      const u=mapUser(row);
      const token=crypto.randomBytes(24).toString('hex'); sessions.set(token,u.id);
      sendEmail({to:u.email,type:'welcome',subject:'Welcome to Living Communities',html:welcomeEmailHtml(u),userId:u.id}).catch(()=>{});
      return send(res,201,{token,user:safeUser(u)});
    }
    if(p==='/api/auth/me' && req.method==='GET'){
      const u=await requireAuth(req,res); if(!u)return; return send(res,200,{user:safeUser(u)});
    }
    if(p==='/api/auth/logout' && req.method==='POST'){sessions.delete(authToken(req));return send(res,200,{ok:true});}

    // Internal, non-session-authenticated endpoint for an external cron/pinger to trigger the
    // Home Care Plan billing check (reminders + mock charges). Protected by a shared secret, not a login.
    if(p==='/api/internal/run-billing-check' && req.method==='POST'){
      const key=req.headers['x-internal-key']||'';
      if(!INTERNAL_JOB_KEY || key!==INTERNAL_JOB_KEY) return send(res,401,{error:'Unauthorized'});
      const result=await runBillingCheck();
      return send(res,200,{ok:true,...result});
    }

    if(p==='/api/billing/config' && req.method==='GET'){
      return send(res,200,{stripeEnabled:stripeConfigured(),publishableKey:STRIPE_PUBLISHABLE_KEY});
    }

    // Stripe webhook — unauthenticated by session (Stripe isn't a logged-in user); authenticity is
    // proven instead by a valid HMAC signature over the exact raw bytes of the request body.
    if(p==='/api/stripe/webhook' && req.method==='POST'){
      const buf=await rawBody(req);
      const sig=req.headers['stripe-signature'];
      if(!STRIPE_WEBHOOK_SECRET || !verifyStripeSignature(buf,sig,STRIPE_WEBHOOK_SECRET)) return send(res,400,{error:'Invalid signature'});
      let event; try{ event=JSON.parse(buf.toString('utf8')); }catch(e){ return send(res,400,{error:'Invalid payload'}); }
      const seen=await q1('SELECT id FROM stripe_events WHERE id=$1',[event.id]);
      if(seen) return send(res,200,{ok:true,duplicate:true});
      await pool.query('INSERT INTO stripe_events (id,type) VALUES ($1,$2)',[event.id,event.type]).catch(()=>{});
      try{
        if(event.type==='invoice.payment_succeeded'){
          const inv=event.data.object;
          const row=await q1('SELECT * FROM users WHERE stripe_customer_id=$1',[inv.customer]);
          if(row){
            const subId=inv.subscription;
            const periodEnd=inv.lines?.data?.[0]?.period?.end || inv.period_end;
            const amount=((inv.amount_paid||0)/100).toFixed(2);
            if(subId && subId===row.care_plan_stripe_subscription_id){
              const nextBilling=periodEnd?new Date(periodEnd*1000).toISOString().slice(0,10):null;
              await pool.query('UPDATE users SET care_plan_next_billing=$1, care_plan_reminder_sent_for=NULL WHERE id=$2',[nextBilling,row.id]);
              await sendEmail({to:row.email,type:'care_plan_billed',subject:'Your card was charged for your Home Care Plan',html:carePlanBilledEmailHtml(row,amount,nextBilling||new Date()),userId:row.id});
            } else if(subId && subId===row.stripe_subscription_id){
              await sendEmail({to:row.email,type:'subscription_billed',subject:'Your Living Communities plan was renewed',html:emailShell('Plan renewed',`<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged $${amount} for your ${esc_(row.subscription)} plan.</p>`),userId:row.id});
            } else if(subId && subId===row.provider_plan_stripe_subscription_id){
              await sendEmail({to:row.email,type:'provider_plan_billed',subject:'Your Pro Provider plan was renewed',html:emailShell('Plan renewed',`<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged $${amount} for your Pro Provider plan.</p>`),userId:row.id});
            }
          }
        } else if(event.type==='invoice.payment_failed'){
          const inv=event.data.object;
          const row=await q1('SELECT * FROM users WHERE stripe_customer_id=$1',[inv.customer]);
          if(row) await sendEmail({to:row.email,type:'payment_failed',subject:'Your payment could not be processed',html:emailShell('Payment failed',`<h2 style="margin:0 0 10px;color:#17352f">We couldn't charge your card</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Please update your payment method from your dashboard to keep your plan active.</p>`),userId:row.id});
        } else if(event.type==='customer.subscription.deleted'){
          const sub=event.data.object;
          const row=await q1('SELECT * FROM users WHERE stripe_customer_id=$1',[sub.customer]);
          if(row){
            if(sub.id===row.care_plan_stripe_subscription_id) await pool.query('UPDATE users SET care_plan_services=$1, care_plan_next_billing=NULL, care_plan_stripe_subscription_id=NULL WHERE id=$2',[[],row.id]);
            if(sub.id===row.stripe_subscription_id) await pool.query("UPDATE users SET subscription='free', stripe_subscription_id=NULL WHERE id=$1",[row.id]);
            if(sub.id===row.provider_plan_stripe_subscription_id) await pool.query("UPDATE users SET provider_plan='free', provider_plan_stripe_subscription_id=NULL WHERE id=$1",[row.id]);
          }
        }
      }catch(e){ console.error('webhook handling error:',e.message); }
      return send(res,200,{ok:true});
    }

    const u=await requireAuth(req,res); if(!u)return;

    if(p==='/api/billing/setup-intent' && req.method==='POST'){
      if(!stripeConfigured()) return send(res,501,{error:'Stripe is not configured on this server yet.',demoMode:true});
      try{
        const customerId=await ensureStripeCustomer(u);
        const si=await stripeRequest('POST','setup_intents',{customer:customerId,payment_method_types:['card']});
        return send(res,200,{clientSecret:si.client_secret});
      }catch(e){ return sendStripeError(res,e); }
    }

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
      if(u.role==='provider'){ const usage=await ensureUsagePeriod(u); u.quotesUsed=usage.quotes; u.convosUsed=usage.convos; }
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
      if(u.providerPlan!=='pro'){
        const usage=await ensureUsagePeriod(u);
        if(usage.quotes>=PROVIDER_FREE_QUOTE_LIMIT) return send(res,402,{error:"You've sent "+PROVIDER_FREE_QUOTE_LIMIT+" quotes this month on the Free plan. Upgrade to Pro Provider for unlimited quotes.",upgradeRequired:true});
      }
      const b=await body(req);
      const row=await q1('INSERT INTO quotes (id,request_id,provider_id,amount_min,amount_max,availability,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id('quote'),rid,u.id,Number(b.amountMin||0),Number(b.amountMax||0),String(b.availability||'Flexible').slice(0,120),String(b.message||'').slice(0,1000),'pending']);
      if(u.providerPlan!=='pro') await pool.query('UPDATE users SET quotes_sent_this_period=quotes_sent_this_period+1 WHERE id=$1',[u.id]);
      const homeownerRow=await q1('SELECT * FROM users WHERE id=$1',[r.homeowner_id]);
      if(homeownerRow) sendEmail({to:homeownerRow.email,type:'new_quote',subject:`New quote on "${r.title}"`,html:newQuoteEmailHtml(homeownerRow,r,row,u),userId:homeownerRow.id}).catch(()=>{});
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
        const providerRow=await q1('SELECT * FROM users WHERE id=$1',[quote.provider_id]);
        if(providerRow) sendEmail({to:providerRow.email,type:'quote_accepted',subject:`You got the job: "${updatedReq.title}"`,html:quoteAcceptedEmailHtml(providerRow,updatedReq),userId:providerRow.id}).catch(()=>{});
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
      const recipientRow=await q1('SELECT * FROM users WHERE id=$1',[recipient]); if(!recipientRow)return send(res,404,{error:'Recipient not found'});
      const text=String(b.body||'').trim().slice(0,2000); if(!text)return send(res,400,{error:'Message cannot be empty'});
      let isNewConversation=false;
      if(u.role==='provider' && u.providerPlan!=='pro'){
        const priorMsg=await q1('SELECT id FROM messages WHERE sender_id=$1 AND recipient_id=$2 LIMIT 1',[u.id,recipient]);
        isNewConversation=!priorMsg;
        if(isNewConversation){
          const usage=await ensureUsagePeriod(u);
          if(usage.convos>=PROVIDER_FREE_CONVO_LIMIT) return send(res,402,{error:"You've started "+PROVIDER_FREE_CONVO_LIMIT+" new conversations this month on the Free plan. Upgrade to Pro Provider to message more homeowners.",upgradeRequired:true});
        }
      }
      const row=await q1('INSERT INTO messages (id,sender_id,recipient_id,participants,body,read) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [id('msg'),u.id,recipient,[u.id,recipient],text,false]);
      if(isNewConversation) await pool.query('UPDATE users SET new_conversations_this_period=new_conversations_this_period+1 WHERE id=$1',[u.id]);
      sendEmail({to:recipientRow.email,type:'new_message',subject:`New message from ${u.name}`,html:newMessageEmailHtml(recipientRow.name,u.name,text),userId:recipientRow.id}).catch(()=>{});
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
      let row;
      if(b.plan==='free'){
        if(stripeConfigured()){
          const existing=await q1('SELECT stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          if(existing?.stripe_subscription_id) await stripeRequest('DELETE','subscriptions/'+existing.stripe_subscription_id).catch(()=>{});
        }
        row=await q1('UPDATE users SET subscription=$1, stripe_subscription_id=NULL WHERE id=$2 RETURNING *',[b.plan,u.id]);
      }else if(stripeConfigured()){
        if(!b.paymentMethodId) return send(res,400,{error:'Payment method required'});
        try{
          const customerId=await ensureStripeCustomer(u);
          const priceCents=b.plan==='plus'?999:2499;
          const existing=await q1('SELECT stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          const sub=await stripeSubscribe(customerId,b.paymentMethodId,existing?.stripe_subscription_id,[{unitAmount:priceCents,name:(b.plan==='plus'?'Plus':'Premium')+' plan',interval:'month'}]);
          row=await q1('UPDATE users SET subscription=$1, stripe_subscription_id=$2, stripe_customer_id=$3 WHERE id=$4 RETURNING *',[b.plan,sub.id,customerId,u.id]);
        }catch(e){ return sendStripeError(res,e); }
      }else{
        row=await q1('UPDATE users SET subscription=$1 WHERE id=$2 RETURNING *',[b.plan,u.id]);
      }
      await pool.query('INSERT INTO subscriptions (id,user_id,plan,status) VALUES ($1,$2,$3,$4)',[id('sub'),u.id,b.plan,'active']);
      return send(res,200,{subscription:b.plan,user:safeUser(mapUser(row))});
    }
    if(p==='/api/care-plan' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can manage a Home Care Plan'});
      const b=await body(req);
      const services=Array.isArray(b.services)?b.services.filter(s=>CARE_SERVICE_INFO[s]):[];
      const hadPlan=u.carePlanServices&&u.carePlanServices.length>0;
      const hasPlan=services.length>0;
      let row;
      if(!hasPlan){
        // canceled — stop billing
        if(stripeConfigured()){
          const existing=await q1('SELECT care_plan_stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          if(existing?.care_plan_stripe_subscription_id) await stripeRequest('DELETE','subscriptions/'+existing.care_plan_stripe_subscription_id).catch(()=>{});
        }
        row=await q1('UPDATE users SET care_plan_services=$1, care_plan_next_billing=NULL, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=NULL WHERE id=$2 RETURNING *',[services,u.id]);
      }else if(stripeConfigured()){
        if(!b.paymentMethodId) return send(res,400,{error:'Payment method required'});
        try{
          const customerId=await ensureStripeCustomer(u);
          // Stripe has no "seasonal" billing interval — Holiday Lighting's one-time-per-season
          // charge is approximated here as a yearly recurring line item.
          const items=services.map(k=>({unitAmount:Math.round(CARE_SERVICE_INFO[k].price*100),name:CARE_SERVICE_INFO[k].name,interval:CARE_SERVICE_INFO[k].billing==='season'?'year':'month'}));
          const existing=await q1('SELECT care_plan_stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          const sub=await stripeSubscribe(customerId,b.paymentMethodId,existing?.care_plan_stripe_subscription_id,items);
          const nextBilling=sub.current_period_end?new Date(sub.current_period_end*1000).toISOString().slice(0,10):null;
          row=await q1('UPDATE users SET care_plan_services=$1, care_plan_next_billing=$2, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=$3, stripe_customer_id=$4 WHERE id=$5 RETURNING *',[services,nextBilling,sub.id,customerId,u.id]);
        }catch(e){ return sendStripeError(res,e); }
      }else if(!hadPlan){
        // brand-new subscription (demo mode) — start a 30-day billing cycle from today
        const next=new Date(); next.setDate(next.getDate()+30);
        row=await q1('UPDATE users SET care_plan_services=$1, care_plan_next_billing=$2, care_plan_reminder_sent_for=NULL WHERE id=$3 RETURNING *',[services,next.toISOString().slice(0,10),u.id]);
      }else{
        // adding/removing services on an existing demo-mode plan — billing date unchanged
        row=await q1('UPDATE users SET care_plan_services=$1 WHERE id=$2 RETURNING *',[services,u.id]);
      }
      return send(res,200,{carePlanServices:services,user:safeUser(mapUser(row))});
    }
    if(p==='/api/provider-plan' && req.method==='POST'){
      if(u.role!=='provider')return send(res,403,{error:'Only providers have a Pro Provider plan'});
      const b=await body(req);
      const plan=b.plan==='pro'?'pro':'free';
      let row;
      if(plan==='free'){
        if(stripeConfigured()){
          const existing=await q1('SELECT provider_plan_stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          if(existing?.provider_plan_stripe_subscription_id) await stripeRequest('DELETE','subscriptions/'+existing.provider_plan_stripe_subscription_id).catch(()=>{});
        }
        row=await q1("UPDATE users SET provider_plan='free', provider_plan_stripe_subscription_id=NULL WHERE id=$1 RETURNING *",[u.id]);
      }else if(stripeConfigured()){
        if(!b.paymentMethodId) return send(res,400,{error:'Payment method required'});
        try{
          const customerId=await ensureStripeCustomer(u);
          const existing=await q1('SELECT provider_plan_stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          const sub=await stripeSubscribe(customerId,b.paymentMethodId,existing?.provider_plan_stripe_subscription_id,[{unitAmount:PROVIDER_PLAN_PRICE_CENTS,name:'Pro Provider plan',interval:'month'}]);
          row=await q1("UPDATE users SET provider_plan='pro', provider_plan_stripe_subscription_id=$1, stripe_customer_id=$2 WHERE id=$3 RETURNING *",[sub.id,customerId,u.id]);
        }catch(e){ return sendStripeError(res,e); }
      }else{
        row=await q1("UPDATE users SET provider_plan='pro' WHERE id=$1 RETURNING *",[u.id]);
      }
      return send(res,200,{user:safeUser(mapUser(row))});
    }
    if(p==='/api/profile/avatar' && req.method==='POST'){
      const b=await body(req);
      if(b.kind==='icon'){
        if(!AVATAR_ICON_IDS.includes(b.value)) return send(res,400,{error:'Invalid icon selection'});
        const row=await q1("UPDATE users SET avatar_kind='icon', avatar_value=$1 WHERE id=$2 RETURNING *",[b.value,u.id]);
        return send(res,200,{user:safeUser(mapUser(row))});
      }
      if(b.kind==='upload'){
        const dataUrl=String(b.value||'');
        if(!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return send(res,400,{error:'Only PNG, JPEG, or WEBP images are supported'});
        if(dataUrl.length>500000) return send(res,400,{error:'That image is too large. Try a smaller photo.'});
        const row=await q1("UPDATE users SET avatar_kind='upload', avatar_value=$1 WHERE id=$2 RETURNING *",[dataUrl,u.id]);
        return send(res,200,{user:safeUser(mapUser(row))});
      }
      if(b.kind==='none'){
        const row=await q1('UPDATE users SET avatar_kind=NULL, avatar_value=NULL WHERE id=$1 RETURNING *',[u.id]);
        return send(res,200,{user:safeUser(mapUser(row))});
      }
      return send(res,400,{error:'Invalid avatar selection'});
    }
    if(p==='/api/profile/address' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners have a home address'});
      const b=await body(req);
      const address=String(b.address||'').trim().slice(0,200);
      if(!address)return send(res,400,{error:'Enter your home address.'});
      const geo=await geocodeAddress(address);
      if(!geo)return send(res,422,{error:"We couldn't locate that address. Try including street, city, and state."});
      const row=await q1('UPDATE users SET address=$1,lat=$2,lng=$3,geocoded_at=now() WHERE id=$4 RETURNING *',[address,geo.lat,geo.lng,u.id]);
      return send(res,200,{user:safeUser(mapUser(row))});
    }
    if(p==='/api/neighborhood' && req.method==='GET'){
      if(u.role!=='homeowner')return send(res,403,{error:'Neighborhood is for homeowners'});
      if(!u.carePlanServices||!u.carePlanServices.length)return send(res,403,{error:'Neighborhood is a Home Care Plan perk',needsPlan:true});
      if(u.lat==null||u.lng==null)return send(res,200,{needsAddress:true,posts:[]});
      const rows=await q('SELECT np.*, us.name AS author_name, us.avatar_kind AS author_avatar_kind, us.avatar_value AS author_avatar_value FROM neighborhood_posts np JOIN users us ON us.id=np.user_id ORDER BY np.created_at DESC LIMIT 200');
      const posts=rows
        .map(r=>({id:r.id,userId:r.user_id,authorName:r.author_name,authorAvatarKind:r.author_avatar_kind||null,authorAvatarValue:r.author_avatar_value||null,body:r.body,createdAt:toISO(r.created_at),distanceMi:haversineMiles(u.lat,u.lng,Number(r.lat),Number(r.lng))}))
        .filter(post=>post.distanceMi<=0.25)
        .sort((a,b2)=>new Date(b2.createdAt)-new Date(a.createdAt));
      return send(res,200,{posts,needsAddress:false});
    }
    if(p==='/api/neighborhood' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Neighborhood is for homeowners'});
      if(!u.carePlanServices||!u.carePlanServices.length)return send(res,403,{error:'Neighborhood is a Home Care Plan perk'});
      if(u.lat==null||u.lng==null)return send(res,400,{error:'Add your home address first.',needsAddress:true});
      const b=await body(req);
      const text=String(b.body||'').trim().slice(0,600);
      if(!text)return send(res,400,{error:'Write something to post.'});
      const row=await q1('INSERT INTO neighborhood_posts (id,user_id,body,lat,lng) VALUES ($1,$2,$3,$4,$5) RETURNING *',[id('npost'),u.id,text,u.lat,u.lng]);
      return send(res,201,{post:{id:row.id,userId:u.id,authorName:u.name,body:row.body,createdAt:toISO(row.created_at),distanceMi:0}});
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
  .then(()=>{
    server.listen(PORT,()=>console.log(`Living Communities API running at http://localhost:${PORT}`));
    if(!stripeConfigured()){
      // In-process fallback for the billing check — fine while the process stays up, but a
      // free-tier host that sleeps on idle should also (or instead) ping /api/internal/run-billing-check
      // from an external scheduler so reminders/charges aren't silently skipped while asleep.
      runBillingCheck().catch(e=>console.error('billing check failed:',e.message));
      setInterval(()=>{ runBillingCheck().catch(e=>console.error('billing check failed:',e.message)); }, 60*60*1000);
    }else{
      console.log('Stripe is configured — real subscriptions bill themselves; renewals/reminders come from Stripe webhooks instead of the simulated billing check.');
    }
  })
  .catch(e=>{ console.error('Failed to start (check DATABASE_URL):', e); process.exit(1); });
