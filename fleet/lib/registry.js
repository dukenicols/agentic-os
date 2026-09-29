'use strict';
// Fleet registry: which repos the supervisor drives, where their tasks come from, and the limits.
// Lives outside any repo at $FLEET_HOME/fleet.json (default ~/.agentic-os). Invalid config fails closed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LIMITS = {
  maxConcurrent: 2,
  maxRunsPerProjectPerDay: 12,
  maxConsecutiveFailures: 3,
  runTimeoutMinutes: 45,
};
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function fleetHome(env = process.env) {
  return path.resolve(env.FLEET_HOME || path.join(os.homedir(), '.agentic-os'));
}

/** Load and validate fleet.json. Throws with every problem listed; never returns a partial config. */
function loadRegistry(home = fleetHome()) {
  const file = path.join(home, 'fleet.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is missing or not valid JSON (${err.message.replace(/\s+/g, ' ')}); fleet is failing closed.`);
  }
  const problems = validate(raw);
  if (problems.length) throw new Error(`${file} is invalid (${problems.join('; ')}); fleet is failing closed.`);
  return normalize(raw);
}

function validate(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['not a JSON object'];
  if (!Array.isArray(raw.projects) || !raw.projects.length) problems.push('`projects` must be a non-empty array');
  const seen = new Set();
  for (const [i, p] of (Array.isArray(raw.projects) ? raw.projects : []).entries()) {
    const at = `projects[${i}]`;
    if (!p || typeof p !== 'object') {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (typeof p.name !== 'string' || !NAME.test(p.name)) problems.push(`${at}.name must match ${NAME}`);
    else if (seen.has(p.name)) problems.push(`${at}.name "${p.name}" is duplicated`);
    else seen.add(p.name);
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) problems.push(`${at}.path must be an absolute path`);
    if (typeof p.asanaProjectGid !== 'string' || !/^\d+$/.test(p.asanaProjectGid)) problems.push(`${at}.asanaProjectGid must be a numeric string`);
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') problems.push(`${at}.enabled must be a boolean`);
    if (p.allowedTools !== undefined && !(Array.isArray(p.allowedTools) && p.allowedTools.every((t) => typeof t === 'string' && t))) {
      problems.push(`${at}.allowedTools must be an array of non-empty strings`);
    }
  }
  if (raw.asana !== undefined) {
    if (!raw.asana || typeof raw.asana !== 'object') problems.push('`asana` must be an object');
    else if (raw.asana.section !== undefined && (typeof raw.asana.section !== 'string' || !raw.asana.section.trim())) {
      problems.push('`asana.section` must be a non-empty string');
    }
  }
  if (raw.limits !== undefined) {
    if (!raw.limits || typeof raw.limits !== 'object') problems.push('`limits` must be an object');
    else {
      for (const [k, v] of Object.entries(raw.limits)) {
        if (!(k in DEFAULT_LIMITS)) problems.push(`unknown limit \`${k}\``);
        else if (!Number.isInteger(v) || v < 1) problems.push(`limits.${k} must be a positive integer`);
      }
    }
  }
  if (raw.claudeBin !== undefined && (typeof raw.claudeBin !== 'string' || !raw.claudeBin)) problems.push('`claudeBin` must be a non-empty string');
  return problems;
}

function normalize(raw) {
  return {
    projects: raw.projects.map((p) => ({
      name: p.name,
      path: path.resolve(p.path),
      asanaProjectGid: p.asanaProjectGid,
      enabled: p.enabled !== false,
      allowedTools: p.allowedTools || [],
    })),
    asana: { section: (raw.asana?.section || 'Agente').trim() },
    limits: { ...DEFAULT_LIMITS, ...(raw.limits || {}) },
    claudeBin: raw.claudeBin || 'claude',
  };
}

module.exports = { loadRegistry, fleetHome, validate, DEFAULT_LIMITS };
