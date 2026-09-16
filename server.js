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
  const carePlanItems=r.care_plan_items||[];
  const u={id:r.id,role:r.role,name:r.name,email:r.email,passwordHash:r.password_hash,salt:r.salt,phone:r.phone,createdAt:toISO(r.created_at),subscription:r.subscription,carePlanItems,carePlanServices:carePlanItems.filter(i=>i.status==='active').map(i=>i.key),avatarKind:r.avatar_kind||null,avatarValue:r.avatar_value||null,address:r.address,lat:r.lat!=null?Number(r.lat):null,lng:r.lng!=null?Number(r.lng):null,suspended:!!r.suspended};
  if(r.role==='homeowner'){ u.community=r.community; u.carePlanNextBilling=r.care_plan_next_billing?new Date(r.care_plan_next_billing).toISOString().slice(0,10):null; }
  else if(r.role==='provider'){
    u.serviceTypes=r.service_types||[]; u.rating=r.rating!=null?Number(r.rating):null; u.reviewCount=r.review_count||0; u.verified=!!r.verified; u.businessDescription=r.business_description; u.providerPlan=r.provider_plan||'free'; u.quotesUsed=r.quotes_sent_this_period||0; u.convosUsed=r.new_conversations_this_period||0;
    u.serviceRadiusMi=r.service_radius_mi!=null?Number(r.service_radius_mi):null;
    // Effective radius actually used to filter the feed: Free plan is capped at PROVIDER_FREE_MAX_RADIUS_MI
    // (even if an older saved value exceeds it) and defaults to it once they have a location on file but
    // never picked a radius themselves. Pro plan is unlimited unless they've set their own radius.
    if(u.providerPlan==='pro'){ u.effectiveServiceRadiusMi = u.serviceRadiusMi; }
    else if(u.serviceRadiusMi!=null){ u.effectiveServiceRadiusMi = Math.min(u.serviceRadiusMi, PROVIDER_FREE_MAX_RADIUS_MI); }
    else { u.effectiveServiceRadiusMi = u.lat!=null ? PROVIDER_FREE_DEFAULT_RADIUS_MI : null; }
    // Verification / background-check workflow
    u.entityType=r.provider_entity_type||null;
    u.verificationStatus=r.verification_status||'unverified';
    u.verificationNotes=r.verification_notes||null;
    u.verificationSubmittedAt=toISO(r.verification_submitted_at);
    u.verificationReviewedAt=toISO(r.verification_reviewed_at);
    u.verificationDocuments=r.verification_documents||[];
    u.backgroundCheckStatus=r.background_check_status||'not_requested';
    u.backgroundCheckRequestedAt=toISO(r.background_check_requested_at);
  }
  return u;
}
// The subset of a provider's record that's safe to hand to OTHER users (homeowners viewing a
// quote, the provider directory). Never includes verification documents (ID/license scans),
// review notes, email, phone, or precise location — only what builds trust + lets the
// homeowner recognize/contact them through the app's own messaging.
function publicProviderView(u){
  if(!u) return null;
  return {
    id:u.id, name:u.name, role:u.role, rating:u.rating, reviewCount:u.reviewCount,
    verified:u.verified, verificationStatus:u.verificationStatus, entityType:u.entityType,
    businessDescription:u.businessDescription, serviceTypes:u.serviceTypes,
    avatarKind:u.avatarKind, avatarValue:u.avatarValue, providerPlan:u.providerPlan,
    createdAt:u.createdAt
  };
}
function mapRequest(r){ return {id:r.id,homeownerId:r.homeowner_id,serviceType:r.service_type,title:r.title,description:r.description,urgency:r.urgency,preferredDate:r.preferred_date,preferredTime:r.preferred_time,status:r.status,createdAt:toISO(r.created_at),dispatchedProviderId:r.dispatched_provider_id||null,dispatchedAt:toISO(r.dispatched_at)||null}; }
// Slim account view for the admin accounts list — everything an admin needs to monitor an
// account and its subscription at a glance, but never the heavy/sensitive stuff (password data,
// uploaded verification document images) that a bulk list endpoint has no business returning.
function adminAccountView(u){
  if(!u) return null;
  const base={id:u.id,role:u.role,name:u.name,email:u.email,phone:u.phone,createdAt:u.createdAt,suspended:!!u.suspended};
  if(u.role==='homeowner'){
    return {...base,community:u.community,subscription:normalizeHomeownerPlanKey(u.subscription),carePlanServiceCount:(u.carePlanServices||[]).length,carePlanNextBilling:u.carePlanNextBilling};
  }
  if(u.role==='provider'){
    return {...base,serviceTypes:u.serviceTypes,providerPlan:u.providerPlan,rating:u.rating,reviewCount:u.reviewCount,verified:u.verified,verificationStatus:u.verificationStatus,entityType:u.entityType,backgroundCheckStatus:u.backgroundCheckStatus};
  }
  return base;
}
function mapQuote(r){ return {id:r.id,requestId:r.request_id,providerId:r.provider_id,amountMin:Number(r.amount_min),amountMax:Number(r.amount_max),availability:r.availability,message:r.message,status:r.status,createdAt:toISO(r.created_at)}; }
function mapMessage(r){ return {id:r.id,quoteId:r.quote_id,senderId:r.sender_id,recipientId:r.recipient_id,body:r.body,createdAt:toISO(r.created_at),read:r.read}; }
function mapAnnouncement(r){ return {id:r.id,title:r.title,body:r.body,createdAt:toISO(r.created_at)}; }
function mapSupportMessage(r){ return {id:r.id,userId:r.user_id,senderRole:r.sender_role,body:r.body,createdAt:toISO(r.created_at),read:r.read}; }
function isPaidPlan(u){ return u.role==='provider' ? u.providerPlan==='pro' : ['plus','premium'].includes(u.subscription); }
function mapJob(r){ return {id:r.id,requestId:r.request_id,quoteId:r.quote_id||null,homeownerId:r.homeowner_id,providerId:r.provider_id,serviceType:r.service_type,title:r.title,status:r.status,scheduledFor:r.scheduled_for,createdAt:toISO(r.created_at),receiptDataUrl:r.receipt_data_url||null,receiptNote:r.receipt_note||null,receiptUploadedAt:r.receipt_uploaded_at?toISO(r.receipt_uploaded_at):null}; }
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
// Optional: where "a provider needs review" style admin alerts go. Falls back to ADMIN_EMAIL
// (the bootstrap admin account's address) so this works with zero extra config; set
// ADMIN_NOTIFY_EMAIL separately if admin alerts should go somewhere else (e.g. a shared inbox).
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || '';
const INTERNAL_JOB_KEY = process.env.INTERNAL_JOB_KEY || '';

// --- payments (Stripe REST API — https://stripe.com; no SDK dependency, just fetch) ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
function stripeConfigured(){ return !!STRIPE_SECRET_KEY; }
// $9.99/mo is a suggested default for the provider paywall plan — change freely, it's just a constant.
const PROVIDER_PLAN_PRICE_CENTS = 999;
const PROVIDER_FREE_QUOTE_LIMIT = 3;
const PROVIDER_FREE_CONVO_LIMIT = 3;
const PROVIDER_FREE_MAX_RADIUS_MI = 50;
const PROVIDER_FREE_DEFAULT_RADIUS_MI = 50;

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

// --- provider verification / background-check workflow ---
const VERIFICATION_DOC_RE=/^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
const VERIFICATION_MAX_DOC_BYTES=5_500_000; // ~4MB file once base64-encoded
const VERIFICATION_MAX_DOCS=6;
// No real screening vendor is wired up (needs a signed vendor account + API keys we don't have,
// and this sandbox can't reach the internet to test one anyway). This just records that a check
// was requested so it shows up in the admin queue. To go live: sign up with a vendor that offers
// a HOSTED candidate flow (e.g. Checkr Invitations) — the provider enters SSN/DOB directly on the
// vendor's own site, so this server never touches that data — then call the vendor's "create
// invitation" API here and flip background_check_status via their webhook, the same pattern used
// for the Stripe webhook above.
async function initiateBackgroundCheck(provider){
  console.log(`[background-check] requested for provider ${provider.id} (${provider.email}) — no vendor configured, left as 'requested' for manual admin follow-up.`);
}

const CARE_SERVICE_INFO={
  landscaping:{name:'Landscaping',price:110,billing:'mo'},
  pest:{name:'Pest Control',price:70,billing:'mo'},
  cleaning:{name:'Home Cleaning',price:275,billing:'mo'},
  pool:{name:'Pool Cleaning',price:210,billing:'mo'}
};
// Monthly total is now driven by each item's admin-set priceCents (once active), not the catalog
// price — the catalog price only remains as a marketing "starting around" figure and an admin
// pre-fill suggestion when quoting.
function carePlanMonthlyTotal(items){ return (items||[]).filter(i=>i.status==='active'&&CARE_SERVICE_INFO[i.key]&&CARE_SERVICE_INFO[i.key].billing==='mo').reduce((sum,i)=>sum+(i.priceCents||0),0)/100; }
function carePlanActiveDetails(items){ return (items||[]).filter(i=>i.status==='active'&&CARE_SERVICE_INFO[i.key]).map(i=>({key:i.key,name:CARE_SERVICE_INFO[i.key].name,billing:CARE_SERVICE_INFO[i.key].billing,price:(i.priceCents||0)/100})); }
// Plan catalogs used by the admin account panel: labels/prices for the invoice email, and a rank
// order so we can tell an upgrade (send an invoice) from a downgrade or lateral change (don't).
const HOMEOWNER_PLAN_INFO={free:{label:'Free',priceCents:0,rank:0},plus:{label:'Plus',priceCents:999,rank:1},premium:{label:'Premium',priceCents:2999,rank:2}};
const PROVIDER_PLAN_INFO={free:{label:'Free',priceCents:0,rank:0},pro:{label:'Pro Provider',priceCents:PROVIDER_PLAN_PRICE_CENTS,rank:1}};
// The self-service /api/subscription route has historically stored the homeowner Premium tier as
// 'pro' (a leftover naming mismatch with the admin panel's 'premium'). Normalize on read so both
// old and new rows resolve to the same HOMEOWNER_PLAN_INFO entry everywhere admin code looks up a
// homeowner's plan label/price — the self-service write path itself is untouched.
function normalizeHomeownerPlanKey(v){ return v==='pro' ? 'premium' : (v||'free'); }
// Maps a Home Care Plan service key to the closest provider-facing service category, so the admin's
// "assign a provider" picker can rank providers who actually offer that kind of work first.
const CARE_SERVICE_TO_PROVIDER_TYPE={landscaping:'Lawn & Landscaping',pest:'Pest Control',cleaning:'House Cleaning',pool:'Pool Service'};
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
// details: [{key,name,billing,price}] — every ACTIVE, priced service, so the homeowner sees exactly
// what they're being charged for, not just a total.
function carePlanItemRowsHtml(details){
  return details.map(d=>`<tr><td style="padding:6px 0;color:#3f4f4a">${esc_(d.name)}</td><td style="padding:6px 0;text-align:right;color:#3f4f4a">$${d.price.toFixed(2)}/${d.billing==='season'?'season':'mo'}</td></tr>`).join('');
}
function carePlanReminderEmailHtml(u,details,amount,billingDate){
  return emailShell('Your Home Care Plan renews soon',
    `<h2 style="margin:0 0 10px;color:#17352f">Your plan renews in 7 days</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your Home Care Plan will renew on <b>${fmtDate(billingDate)}</b>. Here's what your card on file will be charged for:</p>
     <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px">${carePlanItemRowsHtml(details)}</table>
     <p style="color:#17352f;font-weight:800;margin-top:10px;font-size:14px;border-top:1px solid #e4e9e6;padding-top:10px">Total: $${Number(amount).toFixed(2)}</p>
     <p style="color:#6d7b77;line-height:1.6;font-size:12.5px;margin-top:12px">No action needed — manage or cancel anytime from your dashboard.</p>
     ${btn('Manage My Plan',APP_URL)}`);
}
function carePlanBilledEmailHtml(u,details,amount,billingDate){
  return emailShell('Your card was charged',
    `<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged for your Home Care Plan, renewing ${fmtDate(billingDate)}. This is a demo charge — no real payment was processed.</p>
     <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px">${carePlanItemRowsHtml(details)}</table>
     <p style="color:#17352f;font-weight:800;margin-top:10px;font-size:14px;border-top:1px solid #e4e9e6;padding-top:10px">Total: $${Number(amount).toFixed(2)}</p>
     ${btn('View Billing',APP_URL)}`);
}
function adminPlanInvoiceEmailHtml(u,planLabel,priceCents,invoiceNo){
  const amount=(priceCents/100).toFixed(2);
  return emailShell(`Invoice ${invoiceNo}`,
    `<h2 style="margin:0 0 10px;color:#17352f">Your plan was upgraded</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Our team moved your account to the <b>${esc_(planLabel)}</b> plan. Here's your invoice for the record.</p>
     <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13.5px">
       <tr><td style="padding:6px 0;color:#6d7b77">Invoice #</td><td style="padding:6px 0;text-align:right;color:#17352f;font-weight:700">${esc_(invoiceNo)}</td></tr>
       <tr><td style="padding:6px 0;color:#6d7b77">Date</td><td style="padding:6px 0;text-align:right;color:#17352f;font-weight:700">${fmtDate(new Date())}</td></tr>
       <tr><td style="padding:6px 0;color:#6d7b77">Billed to</td><td style="padding:6px 0;text-align:right;color:#17352f;font-weight:700">${esc_(u.name)}</td></tr>
     </table>
     <table style="width:100%;border-collapse:collapse;margin-top:14px;border-top:1px solid #e4e9e6;font-size:13.5px">
       <tr><td style="padding:10px 0 4px;color:#3f4f4a">${esc_(planLabel)} plan (monthly)</td><td style="padding:10px 0 4px;text-align:right;color:#3f4f4a">$${amount}</td></tr>
       <tr><td style="padding:10px 0 0;color:#17352f;font-weight:800;border-top:1px solid #e4e9e6">Total</td><td style="padding:10px 0 0;text-align:right;color:#17352f;font-weight:800;border-top:1px solid #e4e9e6">$${amount}/mo</td></tr>
     </table>
     <p style="color:#6d7b77;line-height:1.6;font-size:12.5px;margin-top:16px">Charged to the card on file going forward. Questions about this change? Reply to this email or reach out from your dashboard.</p>
     ${btn('View My Plan',APP_URL)}`);
}
function planChangedEmailHtml(u,planLabel,priceCents){
  const isFree=priceCents<=0;
  return emailShell(isFree?'Your plan was changed':'Your plan is confirmed',
    `<h2 style="margin:0 0 10px;color:#17352f">${isFree?'Plan updated':'You\'re on the '+esc_(planLabel)+' plan'}</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">${isFree
        ? `Your account is now on the <b>${esc_(planLabel)}</b> plan. No further charges will be made.`
        : `Your account was switched to <b>${esc_(planLabel)}</b> at <b>$${(priceCents/100).toFixed(2)}/mo</b>, billed to the card on file.`}</p>
     ${btn('View My Plan',APP_URL)}`);
}
function carePlanRequestedEmailHtml(u,serviceNames){
  return emailShell('We received your Home Care Plan request',
    `<h2 style="margin:0 0 10px;color:#17352f">Got it — pricing coming soon</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">You requested <b>${esc_(serviceNames.join(', '))}</b> on your Home Care Plan. Our team will follow up to schedule a quick visit or consultation, then send you exact pricing to review before anything is billed.</p>
     ${btn('View My Plan',APP_URL)}`);
}
function adminCarePlanQuoteNeededEmailHtml(homeowner,serviceNames){
  return emailShell('Care Plan pricing needed',
    `<h2 style="margin:0 0 10px;color:#17352f">${esc_(homeowner.name)} needs a Care Plan quote</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(homeowner.name)}</b> (${esc_(homeowner.email)}) requested <b>${esc_(serviceNames.join(', '))}</b>. Schedule a visit or consultation, then set pricing from the admin panel.</p>
     ${btn('Set Pricing in Admin',APP_URL+'/#admin')}`);
}
function carePlanQuoteReadyEmailHtml(u,serviceName,priceCents){
  return emailShell('Your Care Plan quote is ready',
    `<h2 style="margin:0 0 10px;color:#17352f">Your ${esc_(serviceName)} quote is ready</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Based on your visit, <b>${esc_(serviceName)}</b> is <b>$${(priceCents/100).toFixed(2)}/mo</b>. Review it and accept from your dashboard to start service — nothing is billed until you accept.</p>
     ${btn('Review & Accept',APP_URL)}`);
}
function carePlanServiceActivatedEmailHtml(u,serviceName,priceCents,monthlyTotal){
  return emailShell(`${serviceName} is active`,
    `<h2 style="margin:0 0 10px;color:#17352f">${esc_(serviceName)} is now active</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">You accepted <b>${esc_(serviceName)}</b> at <b>$${(priceCents/100).toFixed(2)}/mo</b>. Your Home Care Plan now totals <b>$${Number(monthlyTotal).toFixed(2)}/mo</b>.</p>
     ${btn('Manage My Plan',APP_URL)}`);
}
function carePlanServiceCanceledEmailHtml(u,serviceNames){
  return emailShell('A Home Care Plan service was removed',
    `<h2 style="margin:0 0 10px;color:#17352f">Removed from your plan</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(serviceNames.join(', '))}</b> ${serviceNames.length>1?'were':'was'} removed from your Home Care Plan and billing for ${serviceNames.length>1?'them':'it'} has stopped.</p>
     ${btn('View My Plan',APP_URL)}`);
}
function carePlanCanceledEmailHtml(u){
  return emailShell('Your Home Care Plan was canceled',
    `<h2 style="margin:0 0 10px;color:#17352f">Your Home Care Plan was canceled</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">All recurring services on your Home Care Plan were removed and billing for them has stopped.</p>
     ${btn('View My Dashboard',APP_URL)}`);
}
function accountSuspendedEmailHtml(u){
  return emailShell('Your account was suspended',
    `<h2 style="margin:0 0 10px;color:#17352f">Your account has been suspended</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your Living Communities account (${esc_(u.email)}) has been suspended and you've been signed out. If you think this is a mistake, reply to this email and we'll take a look.</p>`);
}
function accountReactivatedEmailHtml(u){
  return emailShell('Your account is active again',
    `<h2 style="margin:0 0 10px;color:#17352f">Welcome back</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your account has been reactivated. You can log back in whenever you're ready.</p>
     ${btn('Log In',APP_URL)}`);
}
function verificationApprovedEmailHtml(u){
  return emailShell('You\'re verified',
    `<h2 style="margin:0 0 10px;color:#17352f">You're verified ✅</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your provider account is now verified. A verified badge now shows on your profile, which homeowners trust more when comparing quotes.</p>
     ${btn('View My Profile',APP_URL)}`);
}
function verificationRejectedEmailHtml(u,notes){
  return emailShell('Update needed on your verification',
    `<h2 style="margin:0 0 10px;color:#17352f">We couldn't verify your account yet</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Here's what needs fixing:</p>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#fbe4e1;border-radius:10px;padding:12px 14px">${esc_(notes)}</p>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Once it's fixed, resubmit your documents from your dashboard.</p>
     ${btn('Resubmit Verification',APP_URL)}`);
}
function verificationSubmittedEmailHtml(u){
  return emailShell('Verification submitted',
    `<h2 style="margin:0 0 10px;color:#17352f">Got it — under review</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">We received your verification documents. Our team typically reviews these within a couple of business days. We'll email you as soon as there's a decision.</p>`);
}
function adminNewVerificationEmailHtml(provider){
  return emailShell('New verification pending',
    `<h2 style="margin:0 0 10px;color:#17352f">A provider needs review</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(provider.name)}</b> (${esc_(provider.email)}) submitted verification documents and is waiting on a decision.</p>
     ${btn('Review in Admin',APP_URL+'/#admin')}`);
}
function adminNewSignupEmailHtml(u){
  return emailShell('New signup',
    `<h2 style="margin:0 0 10px;color:#17352f">New ${esc_(u.role)}: ${esc_(u.name)}</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">${esc_(u.name)} (${esc_(u.email)}) just created a ${esc_(u.role)} account.</p>
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminPlanCancelledEmailHtml(u,planLabel){
  return emailShell('Plan downgraded to Free',
    `<h2 style="margin:0 0 10px;color:#17352f">${esc_(u.name)} dropped to Free</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(u.name)}</b> (${esc_(u.email)}) downgraded from ${esc_(planLabel)} to the Free plan.</p>
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminPaymentFailedEmailHtml(u){
  return emailShell('A payment failed',
    `<h2 style="margin:0 0 10px;color:#17352f">Payment failed</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">A card charge failed for <b>${esc_(u.name)}</b> (${esc_(u.email)}). They've been emailed to update their payment method.</p>
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminLowRatingReviewEmailHtml(provider,homeownerName,rating,text){
  const stars='★'.repeat(rating)+'☆'.repeat(5-rating);
  return emailShell('Low rating posted',
    `<h2 style="margin:0 0 10px;color:#17352f">${stars} for ${esc_(provider.name)}</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(homeownerName)}</b> left <b>${esc_(provider.name)}</b> (${esc_(provider.email)}) a ${rating}-star review.</p>
     ${text?`<p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#fbe4e1;border-radius:10px;padding:12px 14px">"${esc_(text)}"</p>`:''}
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminJobCancelledEmailHtml(job,homeownerName,providerName){
  return emailShell('Job cancelled',
    `<h2 style="margin:0 0 10px;color:#17352f">"${esc_(job.title)}" was cancelled</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Between <b>${esc_(homeownerName)}</b> and <b>${esc_(providerName)}</b>.</p>
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminBackgroundCheckRequestedEmailHtml(provider){
  return emailShell('Background check requested',
    `<h2 style="margin:0 0 10px;color:#17352f">${esc_(provider.name)} requested a background check</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px"><b>${esc_(provider.name)}</b> (${esc_(provider.email)}) opted into a background check when submitting verification. No vendor is wired up yet — this needs manual follow-up.</p>
     ${btn('View in Admin',APP_URL+'/#admin')}`);
}
function adminDigestEmailHtml(stats){
  const row=(label,val)=>`<tr><td style="padding:6px 0;color:#3f4f4a">${esc_(label)}</td><td style="padding:6px 0;text-align:right;color:#17352f;font-weight:700">${val}</td></tr>`;
  return emailShell('Your daily admin digest',
    `<h2 style="margin:0 0 10px;color:#17352f">Daily digest</h2>
     <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px">
       ${row('New homeowners (24h)',stats.newHomeowners)}
       ${row('New providers (24h)',stats.newProviders)}
       ${row('Open requests',stats.openRequests)}
       ${row('Stale requests (24h+, no quotes)',stats.staleRequests)}
       ${row('Verification queue (pending)',stats.pendingVerifications)}
       ${row('Suspended accounts',stats.suspendedAccounts)}
     </table>
     ${btn('Open Admin Dashboard',APP_URL+'/#admin')}`);
}
function jobCompletedEmailHtml(homeowner,job){
  return emailShell('Job completed',
    `<h2 style="margin:0 0 10px;color:#17352f">"${esc_(job.title)}" is complete</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your provider marked this job as completed. Take a minute to leave a review — it helps other homeowners in your community.</p>
     ${btn('Leave a Review',APP_URL)}`);
}
function jobCancelledEmailHtml(recipientName,job){
  return emailShell('Job cancelled',
    `<h2 style="margin:0 0 10px;color:#17352f">"${esc_(job.title)}" was cancelled</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">This job has been marked as cancelled. No further action is needed.</p>
     ${btn('View My Dashboard',APP_URL)}`);
}
function newReviewEmailHtml(provider,rating,text){
  const stars='★'.repeat(rating)+'☆'.repeat(5-rating);
  return emailShell('You got a new review',
    `<h2 style="margin:0 0 10px;color:#17352f">New review: ${stars}</h2>
     ${text?`<p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#eaf4ef;border-radius:10px;padding:12px 14px">"${esc_(text)}"</p>`:''}
     ${btn('View My Profile',APP_URL)}`);
}
function carePlanVisitAssignedEmailHtml(provider,homeownerName,serviceName,note){
  return emailShell('New recurring service assigned',
    `<h2 style="margin:0 0 10px;color:#17352f">You were assigned a recurring service</h2>
     <p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Our team connected you with <b>${esc_(homeownerName)}</b> for their <b>${esc_(serviceName)}</b> Home Care Plan service.${note?(' Note: '+esc_(note)):''}</p>
     ${btn('View My Dashboard',APP_URL)}`);
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
    const mu=mapUser(r);
    const details=carePlanActiveDetails(mu.carePlanItems);
    if(!details.length) continue;
    const nextBilling=new Date(r.care_plan_next_billing).toISOString().slice(0,10);
    const amount=carePlanMonthlyTotal(mu.carePlanItems);
    if(!amount) continue;
    const reminderSentFor=r.care_plan_reminder_sent_for?new Date(r.care_plan_reminder_sent_for).toISOString().slice(0,10):null;
    if(nextBilling===in7Str && reminderSentFor!==nextBilling){
      await sendEmail({to:r.email,type:'care_plan_reminder',subject:'Your Home Care Plan renews in 7 days',html:carePlanReminderEmailHtml(mu,details,amount,nextBilling),userId:r.id});
      await pool.query('UPDATE users SET care_plan_reminder_sent_for=$1 WHERE id=$2',[nextBilling,r.id]);
      reminders++;
    }
    if(nextBilling<=todayStr){
      await sendEmail({to:r.email,type:'care_plan_billed',subject:'Your card was charged for your Home Care Plan',html:carePlanBilledEmailHtml(mu,details,amount,nextBilling),userId:r.id});
      const newNext=new Date(nextBilling+'T00:00:00Z'); newNext.setUTCMonth(newNext.getUTCMonth()+1);
      await pool.query('UPDATE users SET care_plan_next_billing=$1, care_plan_reminder_sent_for=NULL WHERE id=$2',[newNext.toISOString().slice(0,10),r.id]);
      charges++;
    }
  }
  return {reminders,charges,checked:rows.length};
}

// Admin digest — a single rollup email instead of pinging on every event. Meant to be triggered
// once a day (or however often you like) by the same external cron/pinger that hits
// run-billing-check, via /api/internal/run-admin-digest.
async function runAdminDigest(){
  if(!ADMIN_NOTIFY_EMAIL) return {sent:false,reason:'no ADMIN_NOTIFY_EMAIL/ADMIN_EMAIL configured'};
  const [newHomeowners,newProviders,openReqs,staleReqs,pendingVerif,suspendedCount]=await Promise.all([
    q1("SELECT count(*)::int AS n FROM users WHERE role='homeowner' AND created_at > now() - interval '24 hours'"),
    q1("SELECT count(*)::int AS n FROM users WHERE role='provider' AND created_at > now() - interval '24 hours'"),
    q1("SELECT count(*)::int AS n FROM requests WHERE status='open'"),
    q1("SELECT count(*)::int AS n FROM requests r WHERE r.status='open' AND r.created_at < now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM quotes qq WHERE qq.request_id=r.id)"),
    q1("SELECT count(*)::int AS n FROM users WHERE role='provider' AND verification_status='pending'"),
    q1("SELECT count(*)::int AS n FROM users WHERE suspended=true"),
  ]);
  const stats={
    newHomeowners:newHomeowners.n, newProviders:newProviders.n, openRequests:openReqs.n,
    staleRequests:staleReqs.n, pendingVerifications:pendingVerif.n, suspendedAccounts:suspendedCount.n,
  };
  await sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_digest',subject:'Your daily admin digest',html:adminDigestEmailHtml(stats)});
  return {sent:true,stats};
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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_services text[] DEFAULT '{}'`); // legacy — superseded by care_plan_items below, kept only so old rows aren't lost
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS care_plan_items jsonb DEFAULT '[]'::jsonb`); // [{key,status:'requested'|'quoted'|'active',priceCents,quotedAt,acceptedAt}]
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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS service_radius_mi integer`);
  // Provider verification / background-check workflow
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_entity_type text`); // 'individual' | 'business'
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status text DEFAULT 'unverified'`); // unverified | pending | verified | rejected
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_notes text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_submitted_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_reviewed_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_documents jsonb DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS background_check_status text DEFAULT 'not_requested'`); // not_requested | requested | in_progress | clear | consider
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS background_check_requested_at timestamptz`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended boolean DEFAULT false`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS dispatched_provider_id text`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS dispatched_at timestamptz`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS dispatched_note text`);
  // Chat is scoped to a quote (one request + one provider), never to a person. quote_id is
  // required going forward; any pre-existing message with no quote_id is unlinked legacy DM
  // data from the old person-to-person model and is dropped below, once, on boot.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quote_id text REFERENCES quotes(id)`);
  await pool.query(`DELETE FROM messages WHERE quote_id IS NULL`);
  // Either side of a quote thread can flag it for admin review.
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reported boolean DEFAULT false`);
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reported_by text`);
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reported_reason text`);
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS reported_at timestamptz`);
  // A job only counts as done, for the provider, once a receipt closes it out.
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quote_id text REFERENCES quotes(id)`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_data_url text`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_note text`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id text PRIMARY KEY,
      user_id text REFERENCES users(id),
      title text NOT NULL,
      body text NOT NULL,
      created_at timestamptz DEFAULT now()
    )
  `);
  // One thread per user, all messages ordered by time. sender_role is 'user' or 'admin'.
  // Posting/reading is gated to paid plans at the route level, not here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      sender_role text NOT NULL,
      body text NOT NULL,
      created_at timestamptz DEFAULT now(),
      read boolean DEFAULT false
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS care_plan_visits (
      id text PRIMARY KEY,
      homeowner_id text NOT NULL REFERENCES users(id),
      service_key text NOT NULL,
      provider_id text,
      status text NOT NULL DEFAULT 'upcoming',
      scheduled_date date,
      note text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE(homeowner_id, service_key)
    )`);
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
  // One-time move to admin-priced Care Plan services: every account still on the old flat-rate
  // text[] column (and not yet migrated into care_plan_items) gets re-quoted — each of their
  // services drops back to 'requested' with no price, and billing pauses immediately (any real
  // Stripe subscription for it is cancelled) until an admin sets a new price and the homeowner
  // accepts it. Guarded by "care_plan_items is still empty" so this only ever runs once per row.
  const legacyRows = await pool.query("SELECT id, care_plan_services, care_plan_stripe_subscription_id FROM users WHERE role='homeowner' AND care_plan_services<>'{}' AND care_plan_items='[]'::jsonb");
  for(const r of legacyRows.rows){
    if(stripeConfigured() && r.care_plan_stripe_subscription_id){
      await stripeRequest('DELETE','subscriptions/'+r.care_plan_stripe_subscription_id).catch(()=>{});
    }
    const items=(r.care_plan_services||[]).map(k=>({key:k,status:'requested',priceCents:null,quotedAt:null,acceptedAt:null}));
    await pool.query('UPDATE users SET care_plan_items=$1::jsonb, care_plan_next_billing=NULL, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=NULL WHERE id=$2',[JSON.stringify(items),r.id]);
  }
  if(legacyRows.rows.length) console.log(`[care-plan] re-quoted ${legacyRows.rows.length} existing account(s) onto admin pricing — billing paused pending new quotes.`);
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
  if(u.suspended){sessions.delete(token);send(res,403,{error:'This account has been suspended. Contact support if you think this is a mistake.',suspended:true});return null}
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
  const providerMap=Object.fromEntries(providers.map(p=>[p.id,publicProviderView(mapUser(p))]));
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
      if(u.suspended) return send(res,403,{error:'This account has been suspended. Contact support if you think this is a mistake.',suspended:true});
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
      if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_new_signup',subject:`New ${role}: ${u.name}`,html:adminNewSignupEmailHtml(u)}).catch(()=>{});
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
    // Same shared-secret pattern as run-billing-check above — point an external cron/pinger at this
    // once a day (or whatever cadence you like) to get the admin rollup email.
    if(p==='/api/internal/run-admin-digest' && req.method==='POST'){
      const key=req.headers['x-internal-key']||'';
      if(!INTERNAL_JOB_KEY || key!==INTERNAL_JOB_KEY) return send(res,401,{error:'Unauthorized'});
      const result=await runAdminDigest();
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
              await sendEmail({to:row.email,type:'care_plan_billed',subject:'Your card was charged for your Home Care Plan',html:carePlanBilledEmailHtml(mapUser(row),carePlanActiveDetails(mapUser(row).carePlanItems),amount,nextBilling||new Date()),userId:row.id});
            } else if(subId && subId===row.stripe_subscription_id){
              await sendEmail({to:row.email,type:'subscription_billed',subject:'Your Living Communities plan was renewed',html:emailShell('Plan renewed',`<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged $${amount} for your ${esc_(row.subscription)} plan.</p>`),userId:row.id});
            } else if(subId && subId===row.provider_plan_stripe_subscription_id){
              await sendEmail({to:row.email,type:'provider_plan_billed',subject:'Your Pro Provider plan was renewed',html:emailShell('Plan renewed',`<h2 style="margin:0 0 10px;color:#17352f">Payment received</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Your card on file was charged $${amount} for your Pro Provider plan.</p>`),userId:row.id});
            }
          }
        } else if(event.type==='invoice.payment_failed'){
          const inv=event.data.object;
          const row=await q1('SELECT * FROM users WHERE stripe_customer_id=$1',[inv.customer]);
          if(row){
            await sendEmail({to:row.email,type:'payment_failed',subject:'Your payment could not be processed',html:emailShell('Payment failed',`<h2 style="margin:0 0 10px;color:#17352f">We couldn't charge your card</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Please update your payment method from your dashboard to keep your plan active.</p>`),userId:row.id});
            if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_payment_failed',subject:`Payment failed: ${row.name}`,html:adminPaymentFailedEmailHtml(mapUser(row))}).catch(()=>{});
          }
        } else if(event.type==='customer.subscription.deleted'){
          const sub=event.data.object;
          const row=await q1('SELECT * FROM users WHERE stripe_customer_id=$1',[sub.customer]);
          if(row){
            if(sub.id===row.care_plan_stripe_subscription_id) await pool.query("UPDATE users SET care_plan_items='[]'::jsonb, care_plan_next_billing=NULL, care_plan_stripe_subscription_id=NULL WHERE id=$1",[row.id]);
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
      if(u.role==='admin') return send(res,403,{error:'Admins use /api/admin/verifications instead of /api/dashboard'});
      if(u.role==='homeowner'){
        const reqRows=await q('SELECT * FROM requests WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]);
        const qMap=await quotesByRequestId(reqRows.map(r=>r.id));
        const requests=reqRows.map(r=>({...mapRequest(r),quotes:qMap[r.id]||[]}));
        const announcements=await q('SELECT * FROM announcements WHERE user_id=$1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 50',[u.id]);
        const jobs=await q('SELECT * FROM jobs WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]);
        const reviews=await q('SELECT * FROM reviews WHERE homeowner_id=$1',[u.id]);
        return send(res,200,{user:safeUser(u),requests,announcements:announcements.map(mapAnnouncement),jobs:jobs.map(mapJob),reviews:reviews.map(mapReview)});
      }
      if(u.role==='provider'){ const usage=await ensureUsagePeriod(u); u.quotesUsed=usage.quotes; u.convosUsed=usage.convos; }
      // Joins in the homeowner's lat/lng (if they ever geocoded an address) so each request can
      // carry a distanceMi from this provider — used to filter/label the feed by service area.
      // Requests whose homeowner has no geocoded location get distanceMi:null and are never
      // filtered out, so incomplete address data never silently hides real leads.
      const openRows=await q("SELECT r.*, uh.lat AS h_lat, uh.lng AS h_lng FROM requests r JOIN users uh ON uh.id=r.homeowner_id WHERE r.status='open' ORDER BY r.created_at DESC");
      const myQuotes=openRows.length?await q('SELECT * FROM quotes WHERE request_id = ANY($1::text[]) AND provider_id=$2',[openRows.map(r=>r.id),u.id]):[];
      const quoteByReq=Object.fromEntries(myQuotes.map(qq=>[qq.request_id,mapQuote(qq)]));
      const requests=openRows.map(r=>{
        const distanceMi=(u.lat!=null&&u.lng!=null&&r.h_lat!=null&&r.h_lng!=null)?Math.round(haversineMiles(u.lat,u.lng,Number(r.h_lat),Number(r.h_lng))*10)/10:null;
        return {...mapRequest(r),quote:quoteByReq[r.id]||null,distanceMi};
      });
      const announcements=await q('SELECT * FROM announcements WHERE user_id=$1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 50',[u.id]);
      const jobs=await q('SELECT * FROM jobs WHERE provider_id=$1 ORDER BY created_at DESC',[u.id]);
      const reviews=await q('SELECT * FROM reviews WHERE provider_id=$1',[u.id]);
      const completedJobCount=Number((await q1("SELECT count(*)::int AS c FROM jobs WHERE provider_id=$1 AND status='completed' AND receipt_uploaded_at IS NOT NULL",[u.id])).c);
      return send(res,200,{user:{...safeUser(u),completedJobCount},requests,announcements:announcements.map(mapAnnouncement),jobs:jobs.map(mapJob),reviews:reviews.map(mapReview)});
    }

    if(p==='/api/requests' && req.method==='GET'){
      const rows=u.role==='homeowner'?await q('SELECT * FROM requests WHERE homeowner_id=$1 ORDER BY created_at DESC',[u.id]):await q("SELECT * FROM requests WHERE status='open' ORDER BY created_at DESC");
      return send(res,200,{requests:rows.map(mapRequest)});
    }
    if(p==='/api/requests' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can create requests'});
      const b=await body(req);
      const address=String(b.address||'').trim().slice(0,200);
      if(!address) return send(res,400,{error:'Enter your ZIP code or city so nearby providers can find your request.'});
      let lat=u.lat, lng=u.lng;
      // Only re-geocode when the address is new or changed — keeps this fast/cheap for the common case
      // where the homeowner is just confirming their saved address on a new request.
      if(address!==(u.address||'') || lat==null || lng==null){
        const geo=await geocodeAddress(address);
        if(!geo) return send(res,422,{error:"We couldn't locate that ZIP or city. Try being more specific (e.g. \"Richardson, TX\" or \"75080\")."});
        lat=geo.lat; lng=geo.lng;
        await q1('UPDATE users SET address=$1,lat=$2,lng=$3,geocoded_at=now() WHERE id=$4 RETURNING *',[address,lat,lng,u.id]);
      }
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
        const job=(await client.query('INSERT INTO jobs (id,request_id,quote_id,homeowner_id,provider_id,service_type,title,status,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [id('job'),r.id,qid,u.id,quote.provider_id,r.service_type,r.title,'scheduled',quote.availability])).rows[0];
        await client.query('COMMIT');
        const providerRow=await q1('SELECT * FROM users WHERE id=$1',[quote.provider_id]);
        if(providerRow) sendEmail({to:providerRow.email,type:'quote_accepted',subject:`You got the job: "${updatedReq.title}"`,html:quoteAcceptedEmailHtml(providerRow,updatedReq),userId:providerRow.id}).catch(()=>{});
        return send(res,200,{request:mapRequest(updatedReq),job:mapJob(job)});
      }catch(e){ await client.query('ROLLBACK'); throw e; }
      finally{ client.release(); }
    }
    // A quote thread: only the homeowner who owns the request, or the provider who sent this
    // quote, may read/post/report it. Loads request+quote together so both sides of the auth
    // check are available from one round trip.
    async function loadQuoteThread(qid){
      const quote=await q1('SELECT * FROM quotes WHERE id=$1',[qid]); if(!quote)return null;
      const request=await q1('SELECT * FROM requests WHERE id=$1',[quote.request_id]); if(!request)return null;
      return {quote,request};
    }
    if(p.startsWith('/api/quotes/') && p.endsWith('/messages') && req.method==='GET'){
      const qid=p.split('/')[3], t=await loadQuoteThread(qid); if(!t)return send(res,404,{error:'Quote not found'});
      if(u.role!=='admin' && t.request.homeowner_id!==u.id && t.quote.provider_id!==u.id) return send(res,403,{error:'Not authorized'});
      const rows=await q('SELECT * FROM messages WHERE quote_id=$1 ORDER BY created_at',[qid]);
      return send(res,200,{messages:rows.map(mapMessage)});
    }
    if(p.startsWith('/api/quotes/') && p.endsWith('/messages') && req.method==='POST'){
      const qid=p.split('/')[3], t=await loadQuoteThread(qid); if(!t)return send(res,404,{error:'Quote not found'});
      const isHomeowner=t.request.homeowner_id===u.id, isProvider=t.quote.provider_id===u.id;
      if(!isHomeowner && !isProvider) return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      const text=String(b.body||'').trim().slice(0,2000); if(!text)return send(res,400,{error:'Message cannot be empty'});
      const recipientId=isHomeowner?t.quote.provider_id:t.request.homeowner_id;
      const recipientRow=await q1('SELECT * FROM users WHERE id=$1',[recipientId]);
      let isNewConversation=false;
      if(isProvider && u.providerPlan!=='pro'){
        const priorMsg=await q1('SELECT id FROM messages WHERE quote_id=$1 AND sender_id=$2 LIMIT 1',[qid,u.id]);
        isNewConversation=!priorMsg;
        if(isNewConversation){
          const usage=await ensureUsagePeriod(u);
          if(usage.convos>=PROVIDER_FREE_CONVO_LIMIT) return send(res,402,{error:"You've started "+PROVIDER_FREE_CONVO_LIMIT+" new conversations this month on the Free plan. Upgrade to Pro Provider to message more homeowners.",upgradeRequired:true});
        }
      }
      const row=await q1('INSERT INTO messages (id,quote_id,sender_id,recipient_id,participants,body,read) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [id('msg'),qid,u.id,recipientId,[u.id,recipientId],text,false]);
      if(isNewConversation) await pool.query('UPDATE users SET new_conversations_this_period=new_conversations_this_period+1 WHERE id=$1',[u.id]);
      if(recipientRow) sendEmail({to:recipientRow.email,type:'new_message',subject:`New message from ${u.name}`,html:newMessageEmailHtml(recipientRow.name,u.name,text),userId:recipientRow.id}).catch(()=>{});
      return send(res,201,{message:mapMessage(row)});
    }
    if(p.startsWith('/api/quotes/') && p.endsWith('/report') && req.method==='POST'){
      const qid=p.split('/')[3], t=await loadQuoteThread(qid); if(!t)return send(res,404,{error:'Quote not found'});
      if(t.request.homeowner_id!==u.id && t.quote.provider_id!==u.id) return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      const row=await q1("UPDATE quotes SET reported=true, reported_by=$1, reported_reason=$2, reported_at=now() WHERE id=$3 RETURNING *",[u.id,String(b.reason||'').slice(0,500),qid]);
      if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_quote_reported',subject:`A conversation was reported: "${t.request.title}"`,html:emailShell('Reported conversation',`<h2 style="margin:0 0 10px;color:#17352f">"${esc_(t.request.title)}" was reported</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Reported by ${esc_(u.name)}. ${b.reason?esc_(String(b.reason).slice(0,300)):''}</p>${btn('Review in Admin',APP_URL+'/#admin')}`)}).catch(()=>{});
      return send(res,200,{quote:mapQuote(row)});
    }
    if(p.startsWith('/api/jobs/') && req.method==='PATCH'){
      const jid=p.split('/')[3], job=await q1('SELECT * FROM jobs WHERE id=$1',[jid]); if(!job)return send(res,404,{error:'Job not found'});
      if(job.homeowner_id!==u.id&&job.provider_id!==u.id)return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      if(b.status==='completed') return send(res,400,{error:'Upload a receipt to mark this job complete.'});
      let row=job;
      if(['scheduled','in_progress','cancelled'].includes(b.status) && b.status!==job.status){
        row=await q1('UPDATE jobs SET status=$1 WHERE id=$2 RETURNING *',[b.status,jid]);
        if(b.status==='cancelled'){
          const [homeowner,provider]=await Promise.all([q1('SELECT * FROM users WHERE id=$1',[row.homeowner_id]),q1('SELECT * FROM users WHERE id=$1',[row.provider_id])]);
          if(homeowner) sendEmail({to:homeowner.email,type:'job_cancelled',subject:`"${row.title}" was cancelled`,html:jobCancelledEmailHtml(homeowner.name,mapJob(row)),userId:homeowner.id}).catch(()=>{});
          if(provider) sendEmail({to:provider.email,type:'job_cancelled',subject:`"${row.title}" was cancelled`,html:jobCancelledEmailHtml(provider.name,mapJob(row)),userId:provider.id}).catch(()=>{});
          if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_job_cancelled',subject:`Job cancelled: "${row.title}"`,html:adminJobCancelledEmailHtml(mapJob(row),homeowner?.name||'—',provider?.name||'—')}).catch(()=>{});
        }
      }
      return send(res,200,{job:mapJob(row)});
    }
    if(p.startsWith('/api/jobs/') && p.endsWith('/receipt') && req.method==='POST'){
      const jid=p.split('/')[3], job=await q1('SELECT * FROM jobs WHERE id=$1',[jid]); if(!job)return send(res,404,{error:'Job not found'});
      if(job.provider_id!==u.id) return send(res,403,{error:'Only the provider on this job can close it out'});
      if(job.status==='completed') return send(res,400,{error:'This job is already marked complete'});
      const b=await body(req);
      const dataUrl=String(b.receiptDataUrl||''), note=String(b.receiptNote||'').trim().slice(0,500);
      if(!dataUrl && !note) return send(res,400,{error:'Attach a receipt photo/PDF or add a note describing payment.'});
      if(dataUrl){
        if(!VERIFICATION_DOC_RE.test(dataUrl)) return send(res,400,{error:'Receipt must be a PNG, JPEG, WEBP, or PDF file.'});
        if(dataUrl.length>VERIFICATION_MAX_DOC_BYTES) return send(res,400,{error:'Receipt file is too large. Please keep it under 4MB.'});
      }
      const row=await q1(`UPDATE jobs SET status='completed', receipt_data_url=$1, receipt_note=$2, receipt_uploaded_at=now() WHERE id=$3 RETURNING *`,[dataUrl||null,note||null,jid]);
      const homeowner=await q1('SELECT * FROM users WHERE id=$1',[row.homeowner_id]);
      if(homeowner) sendEmail({to:homeowner.email,type:'job_completed',subject:`"${row.title}" is complete`,html:jobCompletedEmailHtml(homeowner,mapJob(row)),userId:homeowner.id}).catch(()=>{});
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
      const providerRow=await q1('SELECT * FROM users WHERE id=$1',[job.provider_id]);
      if(providerRow){
        sendEmail({to:providerRow.email,type:'new_review',subject:`You got a new ${rating}-star review`,html:newReviewEmailHtml(providerRow,rating,row.text),userId:providerRow.id}).catch(()=>{});
        if(rating<=2 && ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_low_rating_review',subject:`Low rating for ${providerRow.name}`,html:adminLowRatingReviewEmailHtml(mapUser(providerRow),u.name,rating,row.text)}).catch(()=>{});
      }
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
          const priceCents=b.plan==='plus'?HOMEOWNER_PLAN_INFO.plus.priceCents:HOMEOWNER_PLAN_INFO.premium.priceCents;
          const existing=await q1('SELECT stripe_subscription_id FROM users WHERE id=$1',[u.id]);
          const sub=await stripeSubscribe(customerId,b.paymentMethodId,existing?.stripe_subscription_id,[{unitAmount:priceCents,name:(b.plan==='plus'?'Plus':'Premium')+' plan',interval:'month'}]);
          row=await q1('UPDATE users SET subscription=$1, stripe_subscription_id=$2, stripe_customer_id=$3 WHERE id=$4 RETURNING *',[b.plan,sub.id,customerId,u.id]);
        }catch(e){ return sendStripeError(res,e); }
      }else{
        row=await q1('UPDATE users SET subscription=$1 WHERE id=$2 RETURNING *',[b.plan,u.id]);
      }
      await pool.query('INSERT INTO subscriptions (id,user_id,plan,status) VALUES ($1,$2,$3,$4)',[id('sub'),u.id,b.plan,'active']);
      if(b.plan!==(u.subscription||'free')){
        const info=HOMEOWNER_PLAN_INFO[normalizeHomeownerPlanKey(b.plan)];
        sendEmail({to:row.email,type:'subscription_changed',subject:`Your plan is now ${info.label}`,html:planChangedEmailHtml(mapUser(row),info.label,info.priceCents),userId:row.id}).catch(()=>{});
        if(b.plan==='free' && ADMIN_NOTIFY_EMAIL){
          const oldInfo=HOMEOWNER_PLAN_INFO[normalizeHomeownerPlanKey(u.subscription)];
          sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_plan_cancelled',subject:`${row.name} downgraded to Free`,html:adminPlanCancelledEmailHtml(mapUser(row),oldInfo.label)}).catch(()=>{});
        }
      }
      return send(res,200,{subscription:b.plan,user:safeUser(mapUser(row))});
    }
    // Rebuilds the homeowner's Stripe subscription (or cancels it) to exactly match their current
    // ACTIVE, priced items — called any time the active set or a price changes. In demo mode there's
    // no equivalent call; care_plan_next_billing is managed directly by the caller instead.
    async function syncCarePlanStripe(homeownerRow, paymentMethodId){
      const activeItems=(homeownerRow.care_plan_items||[]).filter(i=>i.status==='active'&&CARE_SERVICE_INFO[i.key]);
      const existingSubId=homeownerRow.care_plan_stripe_subscription_id;
      if(!activeItems.length){
        if(existingSubId) await stripeRequest('DELETE','subscriptions/'+existingSubId).catch(()=>{});
        return {nextBilling:null,subId:null,customerId:homeownerRow.stripe_customer_id||null};
      }
      const customerId=await ensureStripeCustomer(mapUser(homeownerRow));
      // A fresh card is only collected when accepting a new quote. Resyncing after just dropping a
      // service (other active items remain) reuses the card already on file instead of demanding one.
      let pmId=paymentMethodId;
      if(!pmId){
        const customer=await stripeRequest('GET','customers/'+customerId);
        pmId=customer.invoice_settings?.default_payment_method||customer.default_source||null;
        if(!pmId) throw Object.assign(new Error('Payment method required'),{httpStatus:400});
      }
      const items=activeItems.map(i=>({unitAmount:i.priceCents,name:CARE_SERVICE_INFO[i.key].name,interval:CARE_SERVICE_INFO[i.key].billing==='season'?'year':'month'}));
      const sub=await stripeSubscribe(customerId,pmId,existingSubId,items);
      return {nextBilling:sub.current_period_end?new Date(sub.current_period_end*1000).toISOString().slice(0,10):null,subId:sub.id,customerId};
    }
    // Sets the homeowner's WISHLIST of Care Plan services — no pricing, no payment, no billing
    // happens here. Newly-added keys land as 'requested' and wait on an admin quote; keys dropped
    // that were 'active' stop being billed immediately (their Stripe line item / demo cycle amount
    // drops out). Keys that are already 'requested'/'quoted'/'active' and stay selected are left
    // untouched — re-selecting something already in flight doesn't reset its progress.
    if(p==='/api/care-plan' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can manage a Home Care Plan'});
      const b=await body(req);
      const desiredKeys=Array.isArray(b.services)?[...new Set(b.services.filter(s=>CARE_SERVICE_INFO[s]))]:[];
      const currentItems=u.carePlanItems||[];
      const currentKeys=new Set(currentItems.map(i=>i.key));
      const desiredSet=new Set(desiredKeys);
      const addedKeys=desiredKeys.filter(k=>!currentKeys.has(k));
      const removedItems=currentItems.filter(i=>!desiredSet.has(i.key));
      const removedActiveNames=removedItems.filter(i=>i.status==='active'&&CARE_SERVICE_INFO[i.key]).map(i=>CARE_SERVICE_INFO[i.key].name);
      // Home Care Plan is a Plus/Premium perk — dropping services back down is always allowed (so
      // downgrading Community Plan never leaves someone stuck paying for Home Care Plan), but adding
      // a brand-new one requires Plus/Premium.
      if(addedKeys.length && u.subscription==='free'){
        return send(res,403,{error:'Home Care Plan is included with the Plus and Premium Community plans. Upgrade to build your plan.',upgradeRequired:true,needsCommunityPlan:true});
      }
      const newItems=[
        ...currentItems.filter(i=>desiredSet.has(i.key)),
        ...addedKeys.map(k=>({key:k,status:'requested',priceCents:null,quotedAt:null,acceptedAt:null})),
      ];
      const stillHasActive=newItems.some(i=>i.status==='active');
      let row;
      if(stripeConfigured() && removedActiveNames.length){
        // An active (billed) item was dropped — resync Stripe to the new active set immediately.
        const current=await q1('SELECT * FROM users WHERE id=$1',[u.id]);
        try{
          const {nextBilling,subId}=await syncCarePlanStripe({...current,care_plan_items:newItems}, null);
          row=await q1('UPDATE users SET care_plan_items=$1::jsonb, care_plan_next_billing=$2, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=$3 WHERE id=$4 RETURNING *',[JSON.stringify(newItems),nextBilling,subId,u.id]);
        }catch(e){ if(e.httpStatus) return send(res,e.httpStatus,{error:e.message}); return sendStripeError(res,e); }
      }else if(!stillHasActive && removedActiveNames.length){
        // Dropped down to zero active items — stop billing entirely (demo mode: no Stripe to sync).
        row=await q1('UPDATE users SET care_plan_items=$1::jsonb, care_plan_next_billing=NULL, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=NULL WHERE id=$2 RETURNING *',[JSON.stringify(newItems),u.id]);
      }else{
        row=await q1('UPDATE users SET care_plan_items=$1::jsonb WHERE id=$2 RETURNING *',[JSON.stringify(newItems),u.id]);
      }
      if(addedKeys.length){
        const addedNames=addedKeys.map(k=>CARE_SERVICE_INFO[k].name);
        sendEmail({to:row.email,type:'care_plan_requested',subject:'We received your Home Care Plan request',html:carePlanRequestedEmailHtml(mapUser(row),addedNames),userId:row.id}).catch(()=>{});
        if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_care_plan_quote_needed',subject:`Care Plan pricing needed: ${row.name}`,html:adminCarePlanQuoteNeededEmailHtml(mapUser(row),addedNames)}).catch(()=>{});
      }
      if(!newItems.length && removedItems.length){
        sendEmail({to:row.email,type:'care_plan_canceled',subject:'Your Home Care Plan was canceled',html:carePlanCanceledEmailHtml(mapUser(row)),userId:row.id}).catch(()=>{});
      }else if(removedActiveNames.length){
        sendEmail({to:row.email,type:'care_plan_service_canceled',subject:'A Home Care Plan service was removed',html:carePlanServiceCanceledEmailHtml(mapUser(row),removedActiveNames),userId:row.id}).catch(()=>{});
      }
      return send(res,200,{user:safeUser(mapUser(row))});
    }
    // Homeowner accepts an admin-set price — this is the only place billing actually starts (or
    // grows) for a service.
    if(p==='/api/care-plan/accept' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can manage a Home Care Plan'});
      const b=await body(req);
      const serviceKey=String(b.serviceKey||'');
      const items=u.carePlanItems||[];
      const item=items.find(i=>i.key===serviceKey);
      if(!item||item.status!=='quoted') return send(res,400,{error:'No pending quote for that service'});
      const newItems=items.map(i=>i.key===serviceKey?{...i,status:'active',acceptedAt:new Date().toISOString()}:i);
      let row;
      if(stripeConfigured()){
        const current=await q1('SELECT * FROM users WHERE id=$1',[u.id]);
        try{
          const {nextBilling,subId,customerId}=await syncCarePlanStripe({...current,care_plan_items:newItems}, b.paymentMethodId);
          row=await q1('UPDATE users SET care_plan_items=$1::jsonb, care_plan_next_billing=$2, care_plan_reminder_sent_for=NULL, care_plan_stripe_subscription_id=$3, stripe_customer_id=$4 WHERE id=$5 RETURNING *',[JSON.stringify(newItems),nextBilling,subId,customerId,u.id]);
        }catch(e){ if(e.httpStatus) return send(res,e.httpStatus,{error:e.message}); return sendStripeError(res,e); }
      }else if(!u.carePlanNextBilling){
        // First-ever active item in demo mode — start a fresh 30-day billing cycle.
        const next=new Date(); next.setDate(next.getDate()+30);
        row=await q1('UPDATE users SET care_plan_items=$1::jsonb, care_plan_next_billing=$2, care_plan_reminder_sent_for=NULL WHERE id=$3 RETURNING *',[JSON.stringify(newItems),next.toISOString().slice(0,10),u.id]);
      }else{
        // Already mid-cycle — this item just joins the existing recurring charge.
        row=await q1('UPDATE users SET care_plan_items=$1::jsonb WHERE id=$2 RETURNING *',[JSON.stringify(newItems),u.id]);
      }
      const svc=CARE_SERVICE_INFO[serviceKey];
      sendEmail({to:row.email,type:'care_plan_service_activated',subject:`${svc.name} is now active on your Home Care Plan`,html:carePlanServiceActivatedEmailHtml(mapUser(row),svc.name,item.priceCents,carePlanMonthlyTotal(newItems)),userId:row.id}).catch(()=>{});
      return send(res,200,{user:safeUser(mapUser(row))});
    }
    // Homeowner declines a price they don't want — the service drops off their plan entirely; they
    // can always re-request it (and get a fresh quote) later.
    if(p==='/api/care-plan/decline' && req.method==='POST'){
      if(u.role!=='homeowner')return send(res,403,{error:'Only homeowners can manage a Home Care Plan'});
      const b=await body(req);
      const serviceKey=String(b.serviceKey||'');
      const items=u.carePlanItems||[];
      const item=items.find(i=>i.key===serviceKey);
      if(!item||item.status!=='quoted') return send(res,400,{error:'No pending quote for that service'});
      const newItems=items.filter(i=>i.key!==serviceKey);
      const row=await q1('UPDATE users SET care_plan_items=$1::jsonb WHERE id=$2 RETURNING *',[JSON.stringify(newItems),u.id]);
      return send(res,200,{user:safeUser(mapUser(row))});
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
      if(plan!==(u.providerPlan||'free')){
        const info=PROVIDER_PLAN_INFO[plan];
        sendEmail({to:row.email,type:'provider_plan_changed',subject:`Your plan is now ${info.label}`,html:planChangedEmailHtml(mapUser(row),info.label,info.priceCents),userId:row.id}).catch(()=>{});
        if(plan==='free' && ADMIN_NOTIFY_EMAIL){
          const oldInfo=PROVIDER_PLAN_INFO[u.providerPlan||'free'];
          sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_plan_cancelled',subject:`${row.name} downgraded to Free`,html:adminPlanCancelledEmailHtml(mapUser(row),oldInfo.label)}).catch(()=>{});
        }
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
    if(p==='/api/profile/service-area' && req.method==='POST'){
      if(u.role!=='provider')return send(res,403,{error:'Only providers set a service area'});
      const b=await body(req);
      const address=String(b.address||'').trim().slice(0,200);
      const maxRadiusMi = u.providerPlan==='pro' ? 200 : PROVIDER_FREE_MAX_RADIUS_MI;
      if(!address){
        if(u.providerPlan!=='pro'){
          return send(res,403,{error:`Free plan providers keep a service area (up to ${PROVIDER_FREE_MAX_RADIUS_MI} mi). Upgrade to Pro Provider to see every open request, nationwide.`,upgradeRequired:true});
        }
        // Clearing the field resets to "show every open request" — Pro plan only.
        const row=await q1('UPDATE users SET address=NULL, lat=NULL, lng=NULL, geocoded_at=NULL, service_radius_mi=NULL WHERE id=$1 RETURNING *',[u.id]);
        return send(res,200,{user:safeUser(mapUser(row))});
      }
      const radiusMi=Math.max(1,Math.min(maxRadiusMi,Number(b.radiusMi)||Math.min(25,maxRadiusMi)));
      const geo=await geocodeAddress(address);
      if(!geo) return send(res,422,{error:"We couldn't locate that city or ZIP. Try being more specific (e.g. \"Richardson, TX\" or \"75080\")."});
      const row=await q1('UPDATE users SET address=$1, lat=$2, lng=$3, geocoded_at=now(), service_radius_mi=$4 WHERE id=$5 RETURNING *',[address,geo.lat,geo.lng,radiusMi,u.id]);
      return send(res,200,{user:safeUser(mapUser(row))});
    }
    if(p==='/api/profile/verification' && req.method==='POST'){
      if(u.role!=='provider')return send(res,403,{error:'Only providers submit verification'});
      const b=await body(req);
      const entityType=b.entityType==='business'?'business':(b.entityType==='individual'?'individual':null);
      if(!entityType) return send(res,400,{error:'Choose whether you\'re an individual contractor or a registered business first.'});
      const docsIn=Array.isArray(b.documents)?b.documents:[];
      if(!docsIn.length) return send(res,400,{error:'Upload at least one document.'});
      if(docsIn.length>VERIFICATION_MAX_DOCS) return send(res,400,{error:`You can upload up to ${VERIFICATION_MAX_DOCS} documents.`});
      const requiredTypes = entityType==='business' ? ['business_license','insurance_cert'] : ['government_id'];
      const presentTypes = new Set(docsIn.map(d=>String((d&&d.type)||'')));
      const missingTypes = requiredTypes.filter(t=>!presentTypes.has(t));
      if(missingTypes.length) return send(res,400,{error:`Upload required: ${missingTypes.join(', ')}.`});
      const documents=[];
      for(const d of docsIn){
        const dataUrl=String((d&&d.dataUrl)||'');
        const label=String((d&&d.label)||'Document').trim().slice(0,80);
        const docType=String((d&&d.type)||'other').trim().slice(0,40);
        if(!VERIFICATION_DOC_RE.test(dataUrl)) return send(res,400,{error:`"${label}" must be a PNG, JPEG, WEBP, or PDF file.`});
        if(dataUrl.length>VERIFICATION_MAX_DOC_BYTES) return send(res,400,{error:`"${label}" is too large. Please keep each file under 4MB.`});
        documents.push({type:docType,label,dataUrl,uploadedAt:new Date().toISOString()});
      }
      const wantsBackgroundCheck = entityType==='individual' && !!b.requestBackgroundCheck;
      const bgStatus = wantsBackgroundCheck ? 'requested' : 'not_requested';
      const row=await q1(
        `UPDATE users SET provider_entity_type=$1, verification_documents=$2::jsonb, verification_status='pending',
         verification_notes=NULL, verification_submitted_at=now(), verification_reviewed_at=NULL,
         background_check_status=$3, background_check_requested_at=$4
         WHERE id=$5 RETURNING *`,
        [entityType, JSON.stringify(documents), bgStatus, wantsBackgroundCheck?new Date():null, u.id]
      );
      if(wantsBackgroundCheck) initiateBackgroundCheck(mapUser(row)); // stub — see function comment
      sendEmail({to:row.email,type:'verification_submitted',subject:'Verification submitted',html:verificationSubmittedEmailHtml(mapUser(row)),userId:row.id}).catch(()=>{});
      if(ADMIN_NOTIFY_EMAIL){
        sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_new_verification',subject:`New verification pending: ${row.name}`,html:adminNewVerificationEmailHtml(mapUser(row))}).catch(()=>{});
        if(wantsBackgroundCheck) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_background_check_requested',subject:`Background check requested: ${row.name}`,html:adminBackgroundCheckRequestedEmailHtml(mapUser(row))}).catch(()=>{});
      }
      return send(res,200,{user:safeUser(mapUser(row))});
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
      return send(res,200,{providers:rows.map(r=>publicProviderView(mapUser(r)))});
    }
    if(p==='/api/admin/verifications' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const status=String(url.searchParams.get('status')||'pending');
      const rows = status==='all'
        ? await q("SELECT * FROM users WHERE role='provider' AND verification_status<>'unverified' ORDER BY verification_submitted_at DESC NULLS LAST")
        : await q("SELECT * FROM users WHERE role='provider' AND verification_status=$1 ORDER BY verification_submitted_at ASC NULLS LAST",[status]);
      // Admin sees the full record — including uploaded documents — since reviewing them is the point.
      return send(res,200,{providers:rows.map(r=>safeUser(mapUser(r)))});
    }
    if(p.startsWith('/api/admin/verifications/') && p.endsWith('/decision') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const pid=p.split('/')[4];
      const b=await body(req);
      const decision=b.decision==='approve'?'approve':(b.decision==='reject'?'reject':null);
      if(!decision) return send(res,400,{error:'decision must be "approve" or "reject"'});
      const notes=String(b.notes||'').trim().slice(0,1000);
      if(decision==='reject' && !notes) return send(res,400,{error:'Add a note explaining why, so the provider knows what to fix.'});
      const target=await q1("SELECT * FROM users WHERE id=$1 AND role='provider'",[pid]);
      if(!target) return send(res,404,{error:'Provider not found'});
      const verified = decision==='approve';
      const row=await q1(
        `UPDATE users SET verified=$1, verification_status=$2, verification_notes=$3, verification_reviewed_at=now() WHERE id=$4 RETURNING *`,
        [verified, verified?'verified':'rejected', notes||null, pid]
      );
      if(verified){
        sendEmail({to:row.email,type:'verification_approved',subject:"You're verified",html:verificationApprovedEmailHtml(mapUser(row)),userId:row.id}).catch(()=>{});
      }else{
        sendEmail({to:row.email,type:'verification_rejected',subject:'Update needed on your verification',html:verificationRejectedEmailHtml(mapUser(row),notes),userId:row.id}).catch(()=>{});
      }
      return send(res,200,{provider:safeUser(mapUser(row))});
    }

    // --- Admin: platform-wide monitoring, account controls, and manual dispatch ---
    if(p==='/api/admin/stats' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const [homeownerPlans,providerPlans,verif,openReqs,staleReqs,carePlanActive,suspendedCount]=await Promise.all([
        q("SELECT subscription, count(*)::int AS n FROM users WHERE role='homeowner' GROUP BY subscription"),
        q("SELECT provider_plan, count(*)::int AS n FROM users WHERE role='provider' GROUP BY provider_plan"),
        q("SELECT verification_status, count(*)::int AS n FROM users WHERE role='provider' GROUP BY verification_status"),
        q("SELECT count(*)::int AS n FROM requests WHERE status='open'"),
        q("SELECT count(*)::int AS n FROM requests r WHERE r.status='open' AND r.created_at < now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM quotes qq WHERE qq.request_id=r.id)"),
        q("SELECT count(*)::int AS n FROM users WHERE role='homeowner' AND EXISTS (SELECT 1 FROM jsonb_array_elements(care_plan_items) x WHERE x->>'status'='active')"),
        q("SELECT count(*)::int AS n FROM users WHERE suspended=true"),
      ]);
      const toObj=(rows,key)=>Object.fromEntries(rows.map(r=>[r[key]||'unknown',r.n]));
      return send(res,200,{
        totalHomeowners: homeownerPlans.reduce((s,r)=>s+r.n,0),
        totalProviders: providerPlans.reduce((s,r)=>s+r.n,0),
        homeownerPlans: toObj(homeownerPlans,'subscription'),
        providerPlans: toObj(providerPlans,'provider_plan'),
        verificationStatus: toObj(verif,'verification_status'),
        openRequests: openReqs[0].n,
        staleRequests: staleReqs[0].n,
        activeCarePlans: carePlanActive[0].n,
        suspendedAccounts: suspendedCount[0].n,
      });
    }
    if(p==='/api/admin/accounts' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const role=String(url.searchParams.get('role')||'all');
      const status=String(url.searchParams.get('status')||'all'); // all|active|suspended
      const qstr=String(url.searchParams.get('q')||'').trim().toLowerCase();
      const rows = ['homeowner','provider'].includes(role)
        ? await q('SELECT * FROM users WHERE role=$1 ORDER BY created_at DESC',[role])
        : await q("SELECT * FROM users WHERE role IN ('homeowner','provider') ORDER BY created_at DESC");
      let accounts=rows.map(r=>adminAccountView(mapUser(r)));
      if(status==='active') accounts=accounts.filter(a=>!a.suspended);
      if(status==='suspended') accounts=accounts.filter(a=>a.suspended);
      if(qstr) accounts=accounts.filter(a=>(a.name||'').toLowerCase().includes(qstr)||(a.email||'').toLowerCase().includes(qstr));
      return send(res,200,{accounts});
    }
    if(p.startsWith('/api/admin/accounts/') && p.endsWith('/suspend') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const aid=p.split('/')[4];
      const target=await q1('SELECT * FROM users WHERE id=$1',[aid]);
      if(!target) return send(res,404,{error:'Account not found'});
      if(target.role==='admin') return send(res,403,{error:'Cannot suspend an admin account'});
      const b=await body(req);
      const suspended=!!b.suspended;
      const row=await q1('UPDATE users SET suspended=$1 WHERE id=$2 RETURNING *',[suspended,aid]);
      if(suspended){
        sendEmail({to:row.email,type:'account_suspended',subject:'Your account was suspended',html:accountSuspendedEmailHtml(mapUser(row)),userId:row.id}).catch(()=>{});
      }else{
        sendEmail({to:row.email,type:'account_reactivated',subject:'Your account is active again',html:accountReactivatedEmailHtml(mapUser(row)),userId:row.id}).catch(()=>{});
      }
      return send(res,200,{account:adminAccountView(mapUser(row))});
    }
    if(p.startsWith('/api/admin/accounts/') && p.endsWith('/subscription') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const aid=p.split('/')[4];
      const target=await q1('SELECT * FROM users WHERE id=$1',[aid]);
      if(!target) return send(res,404,{error:'Account not found'});
      const b=await body(req);
      let row, isUpgrade=false, planInfo=null;
      if(target.role==='homeowner'){
        const plan=['free','plus','premium'].includes(b.subscription)?b.subscription:null;
        if(!plan) return send(res,400,{error:'subscription must be free, plus, or premium'});
        const oldPlan=normalizeHomeownerPlanKey(target.subscription);
        row=await q1('UPDATE users SET subscription=$1 WHERE id=$2 RETURNING *',[plan,aid]);
        planInfo=HOMEOWNER_PLAN_INFO[plan];
        isUpgrade=planInfo.rank>(HOMEOWNER_PLAN_INFO[oldPlan]?.rank??0);
      } else if(target.role==='provider'){
        const plan=['free','pro'].includes(b.providerPlan)?b.providerPlan:null;
        if(!plan) return send(res,400,{error:'providerPlan must be free or pro'});
        const oldPlan=target.provider_plan||'free';
        row=await q1('UPDATE users SET provider_plan=$1 WHERE id=$2 RETURNING *',[plan,aid]);
        planInfo=PROVIDER_PLAN_INFO[plan];
        isUpgrade=planInfo.rank>(PROVIDER_PLAN_INFO[oldPlan]?.rank??0);
      } else {
        return send(res,400,{error:'This account type has no subscription to change'});
      }
      let invoiceNo=null;
      if(isUpgrade && planInfo.priceCents>0 && row.email){
        invoiceNo='INV-'+crypto.randomBytes(5).toString('hex').toUpperCase();
        await pool.query('INSERT INTO announcements (id,user_id,title,body) VALUES ($1,$2,$3,$4)',
          [id('ann'),row.id,'Plan upgraded',`An admin upgraded your plan to ${planInfo.label} ($${(planInfo.priceCents/100).toFixed(2)}/mo). An invoice was emailed to you.`]);
        sendEmail({to:row.email,type:'admin_plan_invoice',subject:`Your invoice for the ${planInfo.label} plan (${invoiceNo})`,html:adminPlanInvoiceEmailHtml(mapUser(row),planInfo.label,planInfo.priceCents,invoiceNo),userId:row.id}).catch(()=>{});
      }
      return send(res,200,{account:adminAccountView(mapUser(row)),invoiceSent:!!invoiceNo,invoiceNo});
    }
    if(p==='/api/admin/requests/stale' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const hours=Math.max(1,Number(url.searchParams.get('hours'))||24);
      const rows=await q(
        `SELECT r.*, uh.name AS homeowner_name, uh.community AS homeowner_community,
                (SELECT count(*)::int FROM quotes qq WHERE qq.request_id=r.id) AS quote_count
         FROM requests r JOIN users uh ON uh.id=r.homeowner_id
         WHERE r.status='open' AND r.created_at < now() - ($1 || ' hours')::interval
           AND NOT EXISTS (SELECT 1 FROM quotes qq WHERE qq.request_id=r.id)
         ORDER BY r.created_at ASC`,
        [String(hours)]
      );
      const requests=rows.map(r=>({...mapRequest(r),homeownerName:r.homeowner_name,homeownerCommunity:r.homeowner_community,quoteCount:r.quote_count}));
      return send(res,200,{requests});
    }
    if(p.startsWith('/api/admin/requests/') && p.endsWith('/candidates') && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const rid=p.split('/')[4];
      const r=await q1('SELECT * FROM requests WHERE id=$1',[rid]);
      if(!r) return send(res,404,{error:'Request not found'});
      const homeowner=await q1('SELECT * FROM users WHERE id=$1',[r.homeowner_id]);
      const providerRows=await q("SELECT * FROM users WHERE role='provider' ORDER BY rating DESC NULLS LAST");
      const candidates=providerRows.map(pr=>{
        const mu=mapUser(pr);
        const matchesService=(mu.serviceTypes||[]).some(s=>s.toLowerCase()===String(r.service_type).toLowerCase());
        const distanceMi=(homeowner&&homeowner.lat!=null&&homeowner.lng!=null&&mu.lat!=null&&mu.lng!=null)
          ? Math.round(haversineMiles(homeowner.lat,homeowner.lng,mu.lat,mu.lng)*10)/10 : null;
        return {id:mu.id,name:mu.name,serviceTypes:mu.serviceTypes,rating:mu.rating,reviewCount:mu.reviewCount,verified:mu.verified,verificationStatus:mu.verificationStatus,providerPlan:mu.providerPlan,suspended:mu.suspended,matchesService,distanceMi};
      }).filter(c=>!c.suspended).sort((a,b2)=>{
        if(a.matchesService!==b2.matchesService) return a.matchesService?-1:1;
        if(a.distanceMi!=null && b2.distanceMi!=null) return a.distanceMi-b2.distanceMi;
        return (b2.rating||0)-(a.rating||0);
      });
      return send(res,200,{candidates,request:mapRequest(r)});
    }
    if(p.startsWith('/api/admin/requests/') && p.endsWith('/assign') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const rid=p.split('/')[4];
      const r=await q1('SELECT * FROM requests WHERE id=$1',[rid]);
      if(!r) return send(res,404,{error:'Request not found'});
      const b=await body(req);
      const providerId=String(b.providerId||'');
      const provider=await q1("SELECT * FROM users WHERE id=$1 AND role='provider'",[providerId]);
      if(!provider) return send(res,404,{error:'Provider not found'});
      const note=String(b.note||'').trim().slice(0,500);
      const row=await q1('UPDATE requests SET dispatched_provider_id=$1, dispatched_at=now(), dispatched_note=$2 WHERE id=$3 RETURNING *',[providerId,note||null,rid]);
      const homeowner=await q1('SELECT * FROM users WHERE id=$1',[r.homeowner_id]);
      const msgToProvider=`An admin connected you with a request: "${r.title}" (${r.service_type}).${note?(' Note: '+note):''} Please review it in your Request Feed and send a quote if you can help.`;
      await pool.query('INSERT INTO announcements (id,user_id,title,body) VALUES ($1,$2,$3,$4)',
        [id('ann'),providerId,'A request needs your help',msgToProvider]);
      if(homeowner){
        const msgToHomeowner=`We reached out directly to ${provider.name}, a trusted local provider, about your request "${r.title}". They'll be in touch shortly.`;
        await pool.query('INSERT INTO announcements (id,user_id,title,body) VALUES ($1,$2,$3,$4)',
          [id('ann'),homeowner.id,'We reached out to a provider for you',msgToHomeowner]);
      }
      if(provider.email) sendEmail({to:provider.email,type:'admin_dispatch',subject:`New request for you: "${r.title}"`,html:emailShell('New request',`<h2 style="margin:0 0 10px;color:#17352f">A request needs your help</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px">Our team connected you with "${esc_(r.title)}" (${esc_(r.service_type)}). Log in and check your Request Feed to send a quote.</p>`),userId:provider.id}).catch(()=>{});
      return send(res,200,{request:mapRequest(row)});
    }

    // Every Home Care Plan homeowner, with the current fulfillment status (provider assigned,
    // upcoming/scheduled/completed, and a date) for each recurring service on their plan — so an
    // admin can see at a glance whether the recurring services people are PAYING for are actually
    // being taken care of, not just whether a one-off request got a quote.
    if(p==='/api/admin/care-plan-accounts' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      // care_plan_items<>'[]' catches every account with a service in ANY stage — requested/quoted/
      // active — not just active ones, so the pending-pricing queue below has something to work with.
      const rows=await q("SELECT * FROM users WHERE role='homeowner' AND care_plan_items<>'[]'::jsonb ORDER BY name ASC");
      const homeownerIds=rows.map(r=>r.id);
      const visits = homeownerIds.length ? await q('SELECT * FROM care_plan_visits WHERE homeowner_id = ANY($1::text[])',[homeownerIds]) : [];
      const providerIds=[...new Set(visits.map(v=>v.provider_id).filter(Boolean))];
      const providerRows = providerIds.length ? await q('SELECT id,name FROM users WHERE id = ANY($1::text[])',[providerIds]) : [];
      const providerNameById=Object.fromEntries(providerRows.map(pr=>[pr.id,pr.name]));
      const visitKey=(hid,sk)=>hid+'|'+sk;
      const visitMap=Object.fromEntries(visits.map(v=>[visitKey(v.homeowner_id,v.service_key),v]));
      const accounts=rows.map(r=>{
        const mu=mapUser(r);
        const services=(mu.carePlanItems||[]).filter(i=>CARE_SERVICE_INFO[i.key]).map(item=>{
          const sk=item.key;
          const v=visitMap[visitKey(r.id,sk)];
          return {
            serviceKey:sk,
            serviceName:CARE_SERVICE_INFO[sk].name,
            catalogPrice:CARE_SERVICE_INFO[sk].price,
            pricingStatus:item.status, // 'requested' | 'quoted' | 'active'
            priceCents:item.priceCents,
            quotedAt:item.quotedAt,
            acceptedAt:item.acceptedAt,
            // Dispatch/fulfillment fields — only meaningful once a service is active and paid for.
            status: v?v.status:'upcoming',
            scheduledDate: v?(v.scheduled_date?new Date(v.scheduled_date).toISOString().slice(0,10):null):null,
            providerId: v?v.provider_id:null,
            providerName: v&&v.provider_id?(providerNameById[v.provider_id]||null):null,
            note: v?v.note:null,
          };
        });
        return {id:mu.id,name:mu.name,email:mu.email,community:mu.community,subscription:normalizeHomeownerPlanKey(mu.subscription),services};
      });
      return send(res,200,{accounts});
    }
    // Admin sets (or revises) the price for a requested/quoted service — this is the only way a
    // homeowner's Care Plan pricing ever gets set. Doesn't touch already-active items; changing the
    // price on something already billing is a separate concern we haven't built yet.
    if(p.startsWith('/api/admin/care-plan-accounts/') && p.endsWith('/quote') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const homeownerId=p.split('/')[4];
      const b=await body(req);
      const serviceKey=String(b.serviceKey||'');
      const priceCents=Math.round(Number(b.priceCents));
      if(!CARE_SERVICE_INFO[serviceKey]) return send(res,400,{error:'Unknown service'});
      if(!Number.isFinite(priceCents)||priceCents<=0) return send(res,400,{error:'Enter a valid price.'});
      const homeowner=await q1("SELECT * FROM users WHERE id=$1 AND role='homeowner'",[homeownerId]);
      if(!homeowner) return send(res,404,{error:'Homeowner not found'});
      const items=homeowner.care_plan_items||[];
      const item=items.find(i=>i.key===serviceKey);
      if(!item) return send(res,404,{error:'This homeowner has not requested that service.'});
      if(item.status==='active') return send(res,400,{error:'This service is already active — adjust it directly with the homeowner instead.'});
      const newItems=items.map(i=>i.key===serviceKey?{...i,status:'quoted',priceCents,quotedAt:new Date().toISOString()}:i);
      const row=await q1('UPDATE users SET care_plan_items=$1::jsonb WHERE id=$2 RETURNING *',[JSON.stringify(newItems),homeownerId]);
      sendEmail({to:row.email,type:'care_plan_quote_ready',subject:`Your ${CARE_SERVICE_INFO[serviceKey].name} quote is ready`,html:carePlanQuoteReadyEmailHtml(mapUser(row),CARE_SERVICE_INFO[serviceKey].name,priceCents),userId:row.id}).catch(()=>{});
      return send(res,200,{ok:true});
    }
    if(p==='/api/admin/care-plan-candidates' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const serviceKey=String(url.searchParams.get('serviceKey')||'');
      const homeownerId=String(url.searchParams.get('homeownerId')||'');
      const wantType=(CARE_SERVICE_TO_PROVIDER_TYPE[serviceKey]||'').toLowerCase();
      const homeowner=homeownerId?await q1('SELECT * FROM users WHERE id=$1',[homeownerId]):null;
      const providerRows=await q("SELECT * FROM users WHERE role='provider' ORDER BY rating DESC NULLS LAST");
      const candidates=providerRows.map(pr=>{
        const mu=mapUser(pr);
        const matchesService=wantType ? (mu.serviceTypes||[]).some(s=>s.toLowerCase()===wantType) : false;
        const distanceMi=(homeowner&&homeowner.lat!=null&&homeowner.lng!=null&&mu.lat!=null&&mu.lng!=null)
          ? Math.round(haversineMiles(homeowner.lat,homeowner.lng,mu.lat,mu.lng)*10)/10 : null;
        return {id:mu.id,name:mu.name,serviceTypes:mu.serviceTypes,rating:mu.rating,reviewCount:mu.reviewCount,verified:mu.verified,providerPlan:mu.providerPlan,suspended:mu.suspended,matchesService,distanceMi};
      }).filter(c=>!c.suspended).sort((a,b2)=>{
        if(a.matchesService!==b2.matchesService) return a.matchesService?-1:1;
        if(a.distanceMi!=null && b2.distanceMi!=null) return a.distanceMi-b2.distanceMi;
        return (b2.rating||0)-(a.rating||0);
      });
      return send(res,200,{candidates});
    }
    if(p==='/api/admin/care-plan-visits' && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      const homeownerId=String(b.homeownerId||'');
      const serviceKey=String(b.serviceKey||'');
      if(!CARE_SERVICE_INFO[serviceKey]) return send(res,400,{error:'Unknown service'});
      const homeowner=await q1("SELECT * FROM users WHERE id=$1 AND role='homeowner'",[homeownerId]);
      if(!homeowner) return send(res,404,{error:'Homeowner not found'});
      if(!mapUser(homeowner).carePlanServices.includes(serviceKey)) return send(res,400,{error:'This homeowner does not have that service active on their plan'});
      const existing=await q1('SELECT * FROM care_plan_visits WHERE homeowner_id=$1 AND service_key=$2',[homeownerId,serviceKey]);
      const has=k=>Object.prototype.hasOwnProperty.call(b,k);
      let providerId = existing ? existing.provider_id : null;
      if(has('providerId')) providerId = b.providerId ? String(b.providerId) : null;
      let status = existing ? existing.status : 'upcoming';
      if(has('status') && ['upcoming','scheduled','completed'].includes(b.status)) status = b.status;
      let scheduledDate = existing ? existing.scheduled_date : null;
      if(has('scheduledDate')) scheduledDate = b.scheduledDate ? String(b.scheduledDate).slice(0,10) : null;
      let note = existing ? existing.note : null;
      if(has('note')) note = String(b.note||'').trim().slice(0,500) || null;
      if(providerId){
        const pr=await q1("SELECT id FROM users WHERE id=$1 AND role='provider'",[providerId]);
        if(!pr) return send(res,400,{error:'Provider not found'});
      }
      const providerChanged = !!providerId && providerId !== (existing?existing.provider_id:null);
      const row=await q1(
        `INSERT INTO care_plan_visits (id,homeowner_id,service_key,provider_id,status,scheduled_date,note,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (homeowner_id,service_key) DO UPDATE SET provider_id=$4,status=$5,scheduled_date=$6,note=$7,updated_at=now()
         RETURNING *`,
        [existing?existing.id:id('cpv'), homeownerId, serviceKey, providerId, status, scheduledDate, note]
      );
      let providerName=null;
      if(row.provider_id){
        const pr=await q1('SELECT id,name,email FROM users WHERE id=$1',[row.provider_id]);
        if(pr){
          providerName=pr.name;
          if(providerChanged){
            const svcName=CARE_SERVICE_INFO[serviceKey].name;
            await pool.query('INSERT INTO announcements (id,user_id,title,body) VALUES ($1,$2,$3,$4)',
              [id('ann'),row.provider_id,'New recurring service assigned',`You were assigned to a recurring Home Care Plan service: ${svcName} for ${homeowner.name}.${note?(' Note: '+note):''}`]);
            sendEmail({to:pr.email||'',type:'care_plan_visit_assigned',subject:`New recurring service: ${svcName}`,html:carePlanVisitAssignedEmailHtml(pr,homeowner.name,svcName,note)}).catch(()=>{});
          }
        }
      }
      return send(res,200,{visit:{serviceKey:row.service_key,serviceName:CARE_SERVICE_INFO[row.service_key].name,status:row.status,scheduledDate:row.scheduled_date?new Date(row.scheduled_date).toISOString().slice(0,10):null,providerId:row.provider_id,providerName,note:row.note}});
    }

    if(p==='/api/support/messages' && req.method==='GET'){
      if(!isPaidPlan(u)) return send(res,403,{error:'Support chat is available on a paid plan.'});
      const rows=await q('SELECT * FROM support_messages WHERE user_id=$1 ORDER BY created_at',[u.id]);
      return send(res,200,{messages:rows.map(mapSupportMessage)});
    }
    if(p==='/api/support/messages' && req.method==='POST'){
      if(!isPaidPlan(u)) return send(res,403,{error:'Support chat is available on a paid plan.'});
      const b=await body(req), text=String(b.body||'').trim().slice(0,2000);
      if(!text) return send(res,400,{error:'Message cannot be empty'});
      const row=await q1('INSERT INTO support_messages (id,user_id,sender_role,body) VALUES ($1,$2,$3,$4) RETURNING *',[id('sup'),u.id,'user',text]);
      if(ADMIN_NOTIFY_EMAIL) sendEmail({to:ADMIN_NOTIFY_EMAIL,type:'admin_support_message',subject:`Support message from ${u.name}`,html:emailShell('Support message',`<h2 style="margin:0 0 10px;color:#17352f">${esc_(u.name)} needs support</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#eaf4ef;border-radius:10px;padding:12px 14px">${esc_(text).slice(0,300)}</p>${btn('Reply in Admin',APP_URL+'/#admin')}`)}).catch(()=>{});
      return send(res,201,{message:mapSupportMessage(row)});
    }
    if(p==='/api/admin/reported-quotes' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const rows=await q("SELECT q.*, r.title AS request_title, r.service_type FROM quotes q JOIN requests r ON r.id=q.request_id WHERE q.reported=true ORDER BY q.reported_at DESC");
      const homeownerIds=[...new Set(rows.map(r=>r.homeowner_id).filter(Boolean))];
      const reqRows=rows.length?await q('SELECT id,homeowner_id FROM requests WHERE id = ANY($1::text[])',[rows.map(r=>r.request_id)]):[];
      const homeownerByReq=Object.fromEntries(reqRows.map(r=>[r.id,r.homeowner_id]));
      const allUserIds=[...new Set(rows.map(r=>r.provider_id).concat(Object.values(homeownerByReq)))];
      const users=allUserIds.length?await q('SELECT id,name,email FROM users WHERE id = ANY($1::text[])',[allUserIds]):[];
      const userMap=Object.fromEntries(users.map(x=>[x.id,{id:x.id,name:x.name,email:x.email}]));
      const out=rows.map(r=>({...mapQuote(r),requestTitle:r.request_title,serviceType:r.service_type,reported:true,reportedBy:userMap[r.reported_by]||null,reportedReason:r.reported_reason,reportedAt:toISO(r.reported_at),provider:userMap[r.provider_id]||null,homeowner:userMap[homeownerByReq[r.request_id]]||null}));
      return send(res,200,{quotes:out});
    }
    if(p==='/api/admin/support' && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const rows=await q(`SELECT sm.user_id, u.name, u.email, u.role,
        max(sm.created_at) AS last_at,
        count(*) FILTER (WHERE sm.sender_role='user' AND sm.read=false)::int AS unread
        FROM support_messages sm JOIN users u ON u.id=sm.user_id GROUP BY sm.user_id,u.name,u.email,u.role ORDER BY last_at DESC`);
      return send(res,200,{threads:rows.map(r=>({userId:r.user_id,name:r.name,email:r.email,role:r.role,lastAt:toISO(r.last_at),unread:r.unread}))});
    }
    if(p.startsWith('/api/admin/support/') && req.method==='GET'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const userId=p.split('/')[4];
      await pool.query("UPDATE support_messages SET read=true WHERE user_id=$1 AND sender_role='user'",[userId]);
      const rows=await q('SELECT * FROM support_messages WHERE user_id=$1 ORDER BY created_at',[userId]);
      return send(res,200,{messages:rows.map(mapSupportMessage)});
    }
    if(p.startsWith('/api/admin/support/') && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const userId=p.split('/')[4];
      const target=await q1('SELECT * FROM users WHERE id=$1',[userId]); if(!target)return send(res,404,{error:'Account not found'});
      const b=await body(req), text=String(b.body||'').trim().slice(0,2000);
      if(!text) return send(res,400,{error:'Message cannot be empty'});
      const row=await q1('INSERT INTO support_messages (id,user_id,sender_role,body) VALUES ($1,$2,$3,$4) RETURNING *',[id('sup'),userId,'admin',text]);
      if(target.email) sendEmail({to:target.email,type:'admin_support_reply',subject:'Reply from Living Communities support',html:emailShell('Support reply',`<h2 style="margin:0 0 10px;color:#17352f">Support replied</h2><p style="color:#3f4f4a;line-height:1.6;font-size:14.5px;background:#eaf4ef;border-radius:10px;padding:12px 14px">${esc_(text).slice(0,300)}</p>${btn('View Reply',APP_URL)}`)}).catch(()=>{});
      return send(res,201,{message:mapSupportMessage(row)});
    }
    if(p==='/api/admin/announcements' && req.method==='POST'){
      if(u.role!=='admin')return send(res,403,{error:'Not authorized'});
      const b=await body(req);
      const title=String(b.title||'').trim().slice(0,120), text=String(b.body||'').trim().slice(0,2000);
      if(!title||!text) return send(res,400,{error:'Title and body are required.'});
      const userId=b.userId?String(b.userId):null;
      if(userId){ const target=await q1('SELECT id,email,name FROM users WHERE id=$1',[userId]); if(!target)return send(res,404,{error:'Account not found'}); }
      const row=await q1('INSERT INTO announcements (id,user_id,title,body) VALUES ($1,$2,$3,$4) RETURNING *',[id('ann'),userId,title,text]);
      return send(res,201,{announcement:mapAnnouncement(row)});
    }
    return send(res,404,{error:'Not found'});
  }catch(e){console.error(e);send(res,500,{error:'Server error',detail:e.message});}
});

// If ADMIN_EMAIL + ADMIN_PASSWORD are set in the environment and no admin account exists yet
// with that email, create one. There's no public "sign up as admin" route on purpose — this is
// the only way to get an admin login, and only you control it via your host's env vars.
async function ensureAdminBootstrap(){
  const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
  const password=String(process.env.ADMIN_PASSWORD||'');
  if(!email||!password) return;
  const existing=await q1('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
  if(existing) return;
  const salt=newSalt();
  await pool.query('INSERT INTO users (id,role,name,email,password_hash,salt) VALUES ($1,$2,$3,$4,$5,$6)',
    [id('usr'),'admin','Admin',email,hash(password,salt),salt]);
  console.log(`[admin] bootstrapped admin account for ${email}`);
}

initSchema()
  .then(seedIfEmpty)
  .then(ensureAdminBootstrap)
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
