'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// vdx needs Node 22 or newer (engines in package.json), and its bins start with
// `env node`: in a project that pins an older node (.nvmrc under fnm or nvm,
// mise) that is the project's node, and tsx stops before vdx starts. Then vdx
// runs again on the node its bin link sits next to — the one whose npm put it
// there; the project's node stays on PATH for the commands vdx runs. This file
// runs on that old node: nothing past Node 14 in it.
// True — the current node will do; false — the re-run or the error owns the exit.
module.exports = function newEnoughNode(entry) {
  if (Number(process.versions.node.split('.')[0]) >= 22) return true;
  const node = real(path.join(path.dirname(process.argv[1]), 'node'));
  if (!node || node === real(process.execPath)) {
    console.error(
      `vdx needs Node.js 22 or newer; the node on PATH here is ${process.version}` +
        ' — the project may pin it (.nvmrc, .node-version, mise.toml)',
    );
    process.exitCode = 1;
    return false;
  }
  const child = spawn(node, [entry].concat(process.argv.slice(2)), { stdio: 'inherit' });
  // Ctrl-C reaches the child from the terminal itself; a signal sent to vdx alone is passed on.
  ['SIGINT', 'SIGQUIT'].forEach((sig) => process.on(sig, () => {}));
  ['SIGTERM', 'SIGHUP'].forEach((sig) => process.on(sig, () => child.kill(sig)));
  child.on('error', (err) => {
    console.error(`vdx: ${node}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 128 + os.constants.signals[signal] : code));
  return false;
};

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
