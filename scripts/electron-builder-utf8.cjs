// electron-builder 25.x concatenates app-builder stdout chunks with `out += data`.
// A UTF-8 character split between Buffer chunks then becomes replacement chars
// in dependency paths. Decode the stream before that collector receives it.
// Scope the compatibility fix to the bundled app-builder executable only.
const childProcess = require('node:child_process');
const path = require('node:path');
const appBuilder = require('app-builder-bin').appBuilderPath;
const canonical = value => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function spawnWithAppBuilderUtf8(command, ...args) {
  const child = originalSpawn.call(this, command, ...args);
  if (typeof command === 'string' && canonical(command) === canonical(appBuilder)) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
  }
  return child;
};
