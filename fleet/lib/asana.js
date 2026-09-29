'use strict';
// Minimal, read-only Asana client. The token comes from ASANA_TOKEN only and never leaves this module:
// it is not logged, not stored, not put in error messages, and not passed to the agent.

const API = 'https://app.asana.com/api/1.0';

function createAsana({ token = process.env.ASANA_TOKEN, fetch = globalThis.fetch } = {}) {
  if (!token) throw new Error('ASANA_TOKEN is not set; put it in the fleet EnvironmentFile. No runs without a task source.');

  async function get(route) {
    let res;
    try {
      res = await fetch(API + route, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (err) {
      throw new Error(`Asana request failed for ${route.split('?')[0]}: ${err.message}`);
    }
    if (!res.ok) throw new Error(`Asana responded ${res.status} for ${route.split('?')[0]}`);
    return (await res.json()).data;
  }

  /** Incomplete tasks in the named section of a project, in Asana order. */
  async function queue(projectGid, sectionName) {
    const sections = await get(`/projects/${encodeURIComponent(projectGid)}/sections?opt_fields=name`);
    const want = sectionName.trim().toLowerCase();
    const section = (sections || []).find((s) => String(s.name || '').trim().toLowerCase() === want);
    // A misnamed section must not look like an empty queue.
    if (!section) throw new Error(`Asana project ${projectGid} has no section named "${sectionName}"`);
    const tasks = await get(
      `/sections/${encodeURIComponent(section.gid)}/tasks?completed_since=now&limit=100&opt_fields=name,notes,permalink_url,completed`,
    );
    return {
      section: section.gid,
      tasks: (tasks || [])
        .filter((t) => !t.completed)
        .map((t) => ({ gid: t.gid, name: t.name || '(untitled)', notes: t.notes || '', url: t.permalink_url || null })),
    };
  }

  return { queue };
}

module.exports = { createAsana, API };
