import assert from 'node:assert/strict';
import postcss from 'postcss';
import { scenePackStyles } from '../src/services/scene/sceneInteractionPackStyles';
import { activate } from './fixtures/s2-arithmetic-pack';
import { scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { S2_JSON_CHECK_PLUGIN, installSceneInteractionCapabilities, s2ComposableCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import type { S2PluginOutcome } from '../src/types/sceneS2Plugin';
globalThis.fetch = async () => assert.fail('Isolation checks never use the network');
const first = { id: 'style-probe', version: '1.0.0' }, second = { ...first, version: '2.0.0' };
const css = `@keyframes pulse {from {color:green} to {color:green}}
@-webkit-keyframes pulse {from {color:green} to {color:green}}
@keyframes linear {from {opacity:.5} to {opacity:1}}
@media (min-width: 1px) {.probe {animation: pulse 2s steps(2, end) infinite, 1s linear linear !important; -webkit-animation-name: "pulse";}}
.variable { --motion:pulse 2s; --alias:var(--motion);animation:var(--alias); }
.fallback {animation-name:var(--name, pulse);}
.unrelated {content:"pulse";background:url("pulse.png");}`;
const a = scenePackStyles(first, css), b = scenePackStyles(second, css);
const definitions = (value: string) => { const names: string[] = []; postcss.parse(value).walkAtRules(/keyframes$/i, rule => { names.push(rule.params); }); return names; };
const names = definitions(a);
assert.equal(names[0], names[1], 'prefixed/unprefixed definitions share one namespaced identity');
assert.notEqual(names[0], definitions(b)[0], 'exact package versions never share animation names');
assert(a.includes(`@scope ([data-scene-pack="style-probe@1.0.0"])`));
assert(a.includes(`animation: ${names[0]} 2s steps(2, end) infinite, 1s linear ${names[2]} !important`));
assert(a.includes(`-webkit-animation-name: "${names[0]}"`));
assert(a.includes(`--motion:${names[0]} 2s`));
assert(a.includes(`var(--name, ${names[0]})`));
assert(a.includes('content:"pulse"') && a.includes('url("pulse.png")'), 'ordinary strings/URLs are not rewritten');
assert.throws(() => scenePackStyles(first, '} body{color:red}'), /Unexpected/);
assert.throws(() => scenePackStyles(first, '@font-face{font-family:global;src:url(x)}'), /全局规则/);
assert.throws(() => scenePackStyles(first, '@import "other.css";'), /全局规则/);
const escaped = scenePackStyles(first, '@keyframes p\\75lse {to{opacity:1}} .x{animation-name:p\\75lse;}');
assert(escaped.includes(`animation-name:${definitions(escaped)[0]}`));
console.log('PASS animation namespaces: versions, nested rules, shorthand/longhand, timing keyword ambiguity, prefixed/quoted/escaped names, local CSS variables/fallbacks, important, inert text and rejected scope escapes/global names');

const shared = { pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' } as const;
const existingBase = scenePackLocalAdapter(null), signal = new AbortController().signal;
const checked = async (adapter: ReturnType<typeof scenePackLocalAdapter>) => {
  const outcome = await adapter(shared as any, { text: ['{}'] }, signal) as S2PluginOutcome;
  assert.equal(outcome.status, 'succeeded');
  assert.equal((outcome.outputs.assessment[0].payload as any).value.status, 'pass');
};
await checked(existingBase);
const before = s2ComposableCapabilities(null);
const pack = activate({ editor: {} as any, ui: { react: {} } });
pack.capabilities.push(structuredClone(S2_JSON_CHECK_PLUGIN));
pack.executeLocal = async () => assert.fail('a package must not replace the shared builtin implementation');
installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
await checked(existingBase); await checked(scenePackLocalAdapter({ id: pack.manifest.id, version: pack.manifest.version }));
assert.deepEqual(s2ComposableCapabilities(null), before, 'a new owner cannot change the base scene public catalogue');
sceneInteractionPacks.setAvailable([]);
assert.equal(sceneInteractionPacks.isCapabilityAvailable(shared.pluginId, shared.pluginVersion), true);
await checked(existingBase);
assert.throws(() => sceneInteractionPacks.setSharedCapabilities([]), /初始化后不能更改/);
assert.equal(sceneInteractionPacks.isCapabilityInScope('arithmetic', '1.0.0', null), false, 'package-only permissions are not broadened');
console.log('PASS shared builtin ownership: existing base calls/catalogue unchanged after duplicate declaration and withdrawal; package cannot shadow builtin handler or expand shared set');
