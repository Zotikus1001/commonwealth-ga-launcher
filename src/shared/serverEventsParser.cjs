const { createHash } = require('crypto');
const { load, FAILSAFE_SCHEMA } = require('js-yaml');

const legacyIds = new Map([
  ['pvp merc fun', 'mercenary-fun'],
  ['pvp challenge night', 'challenge-night'],
  ['pve friday raids', 'friday-raids']
]);
const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_EVENT_BYTES = 128 * 1024;

function parseServerEvents(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_EVENT_BYTES) {
    throw new Error('Event file exceeds 128 KiB');
  }
  const rows = load(source, { schema: FAILSAFE_SCHEMA }) ?? [];
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Events must be a list of at most 100 entries');
  const names = new Set();
  return rows.map((row, index) => {
    const fail = (reason) => { throw new Error(`Event ${index + 1}: ${reason}`); };
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('expected name, day, time and description');
    if (Object.keys(row).some(key => !['name', 'day', 'time', 'description'].includes(key))) fail('unknown field');
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 || /[\x00-\x1f\x7f]/.test(row.name)) fail('invalid name');
    const name = row.name.normalize('NFC').trim().replace(/\s+/g, ' ');
    const identity = name.toLowerCase();
    if (names.has(identity)) fail('duplicate name');
    names.add(identity);
    const weekday = typeof row.day === 'string' ? days.indexOf(row.day.trim().toLowerCase()) : -1;
    if (weekday < 0) fail('use a full weekday name');
    if (typeof row.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)) fail('time must be HH:MM in the 24-hour clock');
    // London clocks jump/repeat at 01:00; avoiding that hour keeps one unambiguous weekly start.
    if (weekday === 0 && row.time.startsWith('01:')) fail('Sunday 01:00–01:59 is ambiguous during London clock changes');
    if (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.description))) fail('invalid description');
    const [hour, minute] = row.time.split(':').map(Number);
    return {
      id: legacyIds.get(identity) || `event-${createHash('sha256').update(identity, 'utf8').digest('hex')}`,
      name, weekday, hour, minute, summary: row.description?.trim() || ''
    };
  });
}

module.exports = { parseServerEvents, MAX_EVENT_BYTES };
