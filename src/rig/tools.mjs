// The fleet and the three tools the agent sees it through.
//
// Carried over from loop-engineering (github.com/shami-rai/loop-engineering),
// where these exact tools, this exact 10-row cap and this exact fleet were the
// control. Keeping them identical is what lets results here be compared with
// results there. Change them only on purpose, and say so.
//
// Two rules hold across all three tools:
//   - results are capped, so no single call can dump the fleet into context
//   - nothing is derived; every computed quantity is the agent's problem
//
// Handlers throw on bad input. What the agent is shown when one throws is
// decided by whoever calls runTool, not here.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const { devices } = JSON.parse(readFileSync(join(ROOT, 'data/fleet.json'), 'utf8'));

export const FIELDS = ['operating_hours', 'alerts', 'risk_score', 'downtime_min'];
export const MAX_LIMIT = 10;

const MODELS = [...new Set(devices.map((d) => d.model))];
const SITES = [...new Set(devices.map((d) => d.site))].sort();

function applyFilters({ model, site, firmware, min_hours, max_hours }) {
  return devices.filter(
    (d) =>
      (model === undefined || d.model === model) &&
      (site === undefined || d.site === site) &&
      (firmware === undefined || d.firmware === firmware) &&
      (min_hours === undefined || d.operating_hours >= min_hours) &&
      (max_hours === undefined || d.operating_hours < max_hours),
  );
}

function findDevice(id) {
  const key = String(id).trim().toLowerCase();
  const exact = devices.find((d) => d.device_id.toLowerCase() === key);
  if (exact) return exact;
  const loose = key.replace(/[^a-z0-9]/g, '');
  const near = devices.filter((d) => d.device_id.toLowerCase().replace(/[^a-z0-9]/g, '') === loose);
  if (near.length === 1) return near[0];
  throw new Error(`No device with id "${id}" in this fleet. Ids look like IL4-007 or AV3-024.`);
}

const FILTER_PROPS = {
  model: { type: 'string', enum: MODELS },
  site: { type: 'string', enum: SITES, description: 'Facility code.' },
  firmware: { type: 'string', description: 'Exact firmware version, e.g. 4.0.1.' },
  min_hours: { type: 'integer', description: 'Inclusive lower bound on operating_hours.' },
  max_hours: { type: 'integer', description: 'Exclusive upper bound on operating_hours.' },
};

// Tool definitions exactly as the model sees them. Clone before editing:
//   const defs = structuredClone(toolDefs)
export const toolDefs = [
  {
    name: 'count_devices',
    description:
      'Count the devices matching a set of filters. Returns only a number. ' +
      'Use this to size a group before asking for rows, since listing tools are capped.',
    input_schema: { type: 'object', properties: { ...FILTER_PROPS } },
  },
  {
    name: 'top_devices',
    description:
      'The highest devices by a single stored field, subject to filters. ' +
      'Returns at most 10 rows of {device_id, model, <field>}. ' +
      'Only stored fields can be ranked: operating_hours, alerts, ' +
      'risk_score (the vendor failure-risk score, 1 to 99, assigned in advance), ' +
      'downtime_min (unplanned downtime in minutes over the window). ' +
      'Derived quantities such as downtime per operating hour are not available here.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELDS, description: 'The field to rank by, highest first.' },
        limit: { type: 'integer', description: `How many rows to return, 1 to ${MAX_LIMIT}. Defaults to 5.` },
        ...FILTER_PROPS,
      },
      required: ['field'],
    },
  },
  {
    name: 'get_device',
    description:
      'The full record for one device: model, site, firmware, operating_hours, alerts, risk_score, downtime_min.',
    input_schema: {
      type: 'object',
      properties: { device_id: { type: 'string', description: 'The device id, e.g. IL4-007.' } },
      required: ['device_id'],
    },
  },
];

export const handlers = {
  count_devices: (input) => ({ count: applyFilters(input).length }),

  top_devices: ({ field, limit = 5, ...filters }) => {
    if (!FIELDS.includes(field)) {
      throw new Error(`Cannot rank by "${field}". Rankable fields are: ${FIELDS.join(', ')}.`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}, got ${limit}.`);
    }
    const matching = applyFilters(filters);
    const rows = [...matching]
      .sort((a, b) => b[field] - a[field])
      .slice(0, limit)
      .map((d) => ({ device_id: d.device_id, model: d.model, [field]: d[field] }));
    return { total_matching: matching.length, returned: rows.length, devices: rows };
  },

  get_device: ({ device_id }) => findDevice(device_id),
};

export function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) throw new Error(`No such tool: ${name}.`);
  return handler(input ?? {});
}
