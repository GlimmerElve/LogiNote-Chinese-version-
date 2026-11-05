import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {constantTimeEqual,decodeBase32,decryptMfaSecret,encodeBase32,encryptMfaSecret,encryptionKey,hashPassword,matchingTotpStep,newTotpSecret,opaqueToken,passwordWithinBounds,tokenHash,totpAt,verifyPassword} from '../src/security.js';

test('scrypt uses independent salts, preserves password bytes, and compares only valid stored parameters',async()=>{
  const password='密码 spaces remain  ',first=await hashPassword(password),second=await hashPassword(password);
  assert.notEqual(first,second);assert.equal(first.includes(password),false);
  assert.equal(await verifyPassword(password,first),true);assert.equal(await verifyPassword(password.trim(),first),false);
  assert.equal(await verifyPassword(password,undefined),false);assert.equal(await verifyPassword(password,'scrypt$1073741824$8$1$bad$bad'),false);
  assert.equal(passwordWithinBounds('short'),false);assert.equal(passwordWithinBounds('a'.repeat(129)),false);assert.equal(passwordWithinBounds('a'.repeat(128)),true);
  assert.equal(constantTimeEqual('same','same'),true);assert.equal(constantTimeEqual('same','other'),false);
});

test('TOTP matches RFC 4226 Appendix D and RFC 6238 Appendix B SHA1 vectors',()=>{
  const bytes=Buffer.from('12345678901234567890'),secret=encodeBase32(bytes);
  assert.deepEqual(decodeBase32(secret),bytes);
  const hotp=['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'];
  hotp.forEach((code,index)=>assert.equal(totpAt(secret,BigInt(index)),code));
  const totpVectors:[[number,string],...[number,string][]]=[[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']];
  for(const [seconds,code] of totpVectors)assert.equal(totpAt(secret,BigInt(Math.floor(seconds/30)),8),code);
  const now=new Date('2026-10-23T00:00:00Z'),step=BigInt(Math.floor(now.getTime()/30000));
  assert.equal(matchingTotpStep(secret,totpAt(secret,step+1n),now,null),step+1n);
  assert.equal(matchingTotpStep(secret,totpAt(secret,step+1n),now,step+1n),null);
  assert.equal(matchingTotpStep(secret,totpAt(secret,step+3n),now,null),null);
  assert.match(newTotpSecret(),/^[A-Z2-7]{32}$/);
});

test('AES-GCM binds MFA ciphertext to an account and rejects tampering without plaintext output',()=>{
  const key=encryptionKey(randomBytes(32).toString('base64url')),secret=newTotpSecret();
  const envelope=encryptMfaSecret(secret,key,'account-a');assert.notEqual(envelope,encryptMfaSecret(secret,key,'account-a'));
  assert.equal(envelope.includes(secret),false);assert.equal(decryptMfaSecret(envelope,key,'account-a'),secret);
  assert.throws(()=>decryptMfaSecret(envelope,key,'account-b'));
  const parts=envelope.split('.'),ciphertext=Buffer.from(parts[2],'base64url');ciphertext[0]^=1;parts[2]=ciphertext.toString('base64url');assert.throws(()=>decryptMfaSecret(parts.join('.'),key,'account-a'));
  assert.throws(()=>encryptionKey('short'));assert.throws(()=>encryptionKey(Buffer.alloc(31).toString('base64url')));
  const token=opaqueToken();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.match(tokenHash(token),/^[0-9a-f]{64}$/);assert.notEqual(tokenHash(token),token);
});
