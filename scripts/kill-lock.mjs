import { execSync } from 'child_process';
try {
  execSync('taskkill /F /PID 33332 2>nul', { stdio: 'pipe' });
  console.log('killed 33332');
} catch {
  console.log('pid not found or already dead');
}
// Also clean lock files
import fs from 'fs';
try { fs.rmSync('F:/inkflow/bot_profiles/bot_wa_01_cloak/lock', { force: true }); } catch {}
try { fs.rmSync('F:/inkflow/bot_profiles/bot_wa_01_cloak/cloak_chrome_data/SingletonLock', { force: true }); } catch {}
try { fs.rmSync('F:/inkflow/bot_profiles/bot_wa_01_cloak/cloak_chrome_data/SingletonCookie', { force: true }); } catch {}
console.log('locks cleaned');
