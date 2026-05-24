#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { register } = require('tsx/esm/api');
register();
import(path.join(__dirname, '..', 'src', 'mcp-server.ts')).catch((err) => {
  console.error(err);
  process.exit(1);
});
