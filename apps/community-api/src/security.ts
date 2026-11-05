import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';

// OWASP's 32 MiB scrypt profile; Node needs maxmem headroom above 128*N*r.
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt
const PASSWORD_N=32768,PASSWORD_R=8,PASSWORD_P=3,KEY_BYTES=64;
const dummySalt=Buffer.alloc(16,0x71),dummyKey=Buffer.alloc(KEY_BYTES);
const base32Alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const opaqueToken=()=>randomBytes(32).toString('base64url');
export const tokenHash=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
export const isOpaqueToken=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
export function constantTimeEqual(left:string,right:string):boolean {
  const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);
}
export function passwordWithinBounds(value:unknown):value is string {
  return typeof value==='string'&&value.length>=12&&value.length<=128&&Buffer.byteLength(value,'utf8')<=512;
}
const derive=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>{
  scrypt(password,salt,KEY_BYTES,{N:PASSWORD_N,r:PASSWORD_R,p:PASSWORD_P,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key));
});
export async function hashPassword(password:string):Promise<string> {
  const salt=randomBytes(16),key=await derive(password,salt);
  return `scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password:string,encoded?:string):Promise<boolean> {
  let salt=dummySalt,expected=dummyKey,valid=false;
  if(encoded){
    const parts=encoded.split('$');
    if(parts.length===6&&parts[0]==='scrypt'&&parts[1]===String(PASSWORD_N)&&parts[2]===String(PASSWORD_R)&&parts[3]===String(PASSWORD_P)){
      const candidateSalt=Buffer.from(parts[4],'base64url'),candidateKey=Buffer.from(parts[5],'base64url');
      if(candidateSalt.length===16&&candidateKey.length===KEY_BYTES){salt=candidateSalt;expected=candidateKey;valid=true;}
    }
  }
  const actual=await derive(password,salt);return timingSafeEqual(actual,expected)&&valid;
}

export function encryptionKey(value:string):Buffer {
  if(!/^[A-Za-z0-9+/_-]{43}=?$/.test(value))throw new Error('AUTH_ENCRYPTION_KEY must encode exactly 32 random bytes.');
  const key=Buffer.from(value,'base64');if(key.length!==32)throw new Error('AUTH_ENCRYPTION_KEY must encode exactly 32 random bytes.');return key;
}
export function encryptMfaSecret(secret:string,key:Buffer,accountId:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
  cipher.setAAD(Buffer.from(`loginote-mfa:${accountId}:v1`));
  const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}
export function decryptMfaSecret(value:string,key:Buffer,accountId:string):string {
  const parts=value.split('.');
  if(parts.length!==4||parts[0]!=='v1')throw new Error('Invalid MFA envelope.');
  const iv=Buffer.from(parts[1],'base64url'),ciphertext=Buffer.from(parts[2],'base64url'),tag=Buffer.from(parts[3],'base64url');
  if(iv.length!==12||tag.length!==16||ciphertext.length>256)throw new Error('Invalid MFA envelope.');
  const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});decipher.setAAD(Buffer.from(`loginote-mfa:${accountId}:v1`));decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
}
export function encodeBase32(bytes:Buffer):string {
  let bits=0,value=0,result='';
  for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+=base32Alphabet[(value>>>(bits-5))&31];bits-=5;}}
  if(bits)result+=base32Alphabet[(value<<(5-bits))&31];return result;
}
export function decodeBase32(secret:string):Buffer {
  if(!/^[A-Z2-7]+$/.test(secret))throw new Error('Invalid TOTP secret.');
  let bits=0,value=0;const bytes:number[]=[];
  for(const letter of secret){value=(value<<5)|base32Alphabet.indexOf(letter);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  return Buffer.from(bytes);
}
export const newTotpSecret=()=>encodeBase32(randomBytes(20));
export function totpAt(secret:string,step:bigint,digits=6):string {
  if(step<0n||step>0xffffffffffffffffn||![6,8].includes(digits))throw new Error('Invalid TOTP parameters.');
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(step);
  const digest=createHmac('sha1',decodeBase32(secret)).update(counter).digest(),offset=digest[digest.length-1]&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
/** RFC 6238: 30-second counter, one neighboring step in either direction. */
export function matchingTotpStep(secret:string,code:string,now:Date,lastStep:bigint|null):bigint|null {
  const center=BigInt(Math.floor(now.getTime()/30000));let matched:bigint|null=null;
  for(const delta of [-1n,0n,1n]){const step=center+delta;if(step>=0n&&constantTimeEqual(totpAt(secret,step),code)&&(lastStep===null||step>lastStep))matched=step;}
  return matched;
}
