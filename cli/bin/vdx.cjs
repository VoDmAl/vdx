#!/usr/bin/env node
'use strict';
if (require('./node-guard.cjs')(__filename)) {
  const path = require('node:path');
  const { register } = require('tsx/esm/api');
  register();
  import(path.join(__dirname, '..', 'src', 'index.ts')).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
