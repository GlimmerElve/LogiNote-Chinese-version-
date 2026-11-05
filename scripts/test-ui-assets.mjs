// Test-only Node loader: styles/assets have no executable behaviour in SSR.
import { registerHooks } from 'node:module';
registerHooks({load(url,context,next){
  if(/\.(?:css|mp3|woff2?)(?:\?.*)?$/u.test(url))return {format:'module',source:'export default "";',shortCircuit:true};
  return next(url,context);
}});
