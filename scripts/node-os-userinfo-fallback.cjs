const os = require('node:os');

try {
  os.userInfo();
} catch (error) {
  // `tsx` asks Node for the current username only to build a temporary-folder name.
  // Some restricted Windows sessions return UV_ENOMEM from uv_os_get_passwd even
  // though the process has enough memory. Keep production code untouched and give
  // the test runner a deterministic, non-sensitive fallback identity.
  const username = process.env.USERNAME || process.env.USER || 'loginote-runner';
  const homedir = process.env.USERPROFILE || process.env.HOMEDRIVE || process.cwd();
  Object.defineProperty(os, 'userInfo', {
    configurable: true,
    value: () => ({ uid: -1, gid: -1, username, homedir, shell: null }),
  });
}
