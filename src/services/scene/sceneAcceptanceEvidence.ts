/** Definite field paths only: no wildcard, expression, inherited member or root-object evidence. */
export function normalizeSceneEvidencePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 200) return undefined;
  let path = raw.trim();
  if (path.startsWith('#/')) path = path.slice(1);
  let parts: string[];
  if (path.startsWith('/')) {
    parts = path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  } else {
    path = path.replace(/^\$\./u, '').replace(/\[(?:"([\w-]+)"|'([\w-]+)'|(\d+))\]/gu,
      (_, quoted, single, index) => `.${quoted ?? single ?? index}`);
    parts = path.split('.');
  }
  if (parts[0] === 'scene') parts.shift();
  if (!parts.length || parts.length > 8 || parts.some(key => !/^[\w-]+$/u.test(key)
    || ['__proto__', 'prototype', 'constructor'].includes(key))) return undefined;
  return parts.join('.');
}

/** Match fields that survive JSON serialization, not optional own-properties whose value is undefined. */
export function sceneEvidencePathExists(scene: object, raw: unknown): boolean {
  const path = normalizeSceneEvidencePath(raw);
  if (!path) return false;
  let value: unknown = scene;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object'
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key))
      || !Object.prototype.propertyIsEnumerable.call(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

/** Bounded index of actual fields. It is a convenience, not a whitelist that excludes other real paths. */
export function sceneAcceptanceEvidencePaths(scene: object): string[] {
  const paths = new Set<string>();
  for (const path of ['meta.goal', 'task', 'rules', 'agentInstructions.response', 'runtimeContract.allowedTools',
    'capabilityIds', 'behavior.aiBehavior', 'inputForm.fields', 'inputForm.fields.0.id', 'experimentPolicy.criteria']) {
    if (sceneEvidencePathExists(scene, path)) paths.add(path);
  }
  const queue = Object.keys(scene).map(path => ({ path, value: (scene as Record<string, unknown>)[path] }));
  for (let index = 0; index < queue.length && paths.size < 128; index++) {
    const { path, value } = queue[index];
    if (!sceneEvidencePathExists(scene, path)) continue;
    paths.add(path);
    if (!value || typeof value !== 'object' || path.split('.').length >= 8) continue;
    for (const key of Object.keys(value).slice(0, 16)) {
      queue.push({ path: `${path}.${key}`, value: (value as Record<string, unknown>)[key] });
    }
  }
  return [...paths];
}
