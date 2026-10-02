import test from 'node:test';
import assert from 'node:assert/strict';
import {configured,loginPage,type PasswordEnv} from '../worker/auth.ts';
test('requires a password between 12 and 256 characters',()=>{
 for(const password of [undefined,'short','x'.repeat(257)])assert.equal(configured({PORTAL_PASSWORD:password} as PasswordEnv),false);
 assert.equal(configured({PORTAL_PASSWORD:'x'.repeat(24)} as PasswordEnv),true);
});
test('login page never caches and forbids framing',async()=>{
 const page=loginPage();assert.equal(page.headers.get('Cache-Control'),'no-store');
 assert.match(page.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);
 assert.match(await page.text(),/type="password"/);
 assert.doesNotMatch(await loginPage('',503,true).text(),/<form/);
});
