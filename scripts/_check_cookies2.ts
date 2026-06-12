import Database from 'better-sqlite3';

const db = new Database('F:/bots/profiles/bot_wa_01/Default/Network/Cookies', { readonly: true });
const igRows = db.prepare("SELECT host_key, name FROM cookies WHERE host_key LIKE '%instagram%'").all() as any[];
console.log('=== IG cookies ===');
igRows.forEach(r => console.log(' ', r.host_key, '|', r.name));

const keyCookies = db.prepare("SELECT host_key, name FROM cookies WHERE name IN ('sessionid','ds_user_id','csrftoken','mid','ig_did')").all() as any[];
console.log('\n=== Key auth cookies ===');
keyCookies.forEach(r => console.log(' ', r.host_key, '|', r.name));

const total = db.prepare('SELECT COUNT(*) as c FROM cookies').get() as any;
console.log('\nTotal cookies:', total.c);
db.close();

// Also check Login Data for IG credentials
const loginDb = new Database('F:/bots/profiles/bot_wa_01/Default/Login Data', { readonly: true });
try {
  const logins = loginDb.prepare("SELECT origin_url, username_value FROM logins WHERE origin_url LIKE '%instagram%'").all() as any[];
  console.log('\n=== Saved IG logins ===');
  logins.forEach(l => console.log(' ', l.origin_url, '|', l.username_value));
  console.log('Total IG saved logins:', logins.length);
} catch {
  console.log('\nCould not read Login Data (may be encrypted)');
}
loginDb.close();
