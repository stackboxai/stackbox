#!/usr/bin/env node
/**
 * stackbox bin entry
 * npx stackbox → starts server + auto-opens browser
 */

const path = require("path");
require(path.join(__dirname, "../dist/server.js"));