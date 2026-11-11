export const TRAFFIC_PERIODS = [5, 10, 30, 60];

export function summarizeTrafficPeriod(events, periodMinutes, now = Date.now()) {
  if (!TRAFFIC_PERIODS.includes(periodMinutes)) {
    throw new RangeError('Traffic period must be 5, 10, 30, or 60 minutes.');
  }
  const end = now instanceof Date ? now.getTime() : now;
  const start = end - periodMinutes * 60_000;
  const periodEvents = (Array.isArray(events) ? events : []).filter(event => {
    const timestamp = Date.parse(event.timestamp);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
  const crossings = periodEvents.filter(event => event.type === 'entry_exit');
  const entryEvents = crossings.filter(event => /\(entry\)/i.test(event.detail || ''));
  const exitEvents = crossings.filter(event => /\(exit\)/i.test(event.detail || ''));
  const people = new Set();
  const byMinute = new Map();
  for (const event of entryEvents) {
    if (event.trackingId !== null && event.trackingId !== undefined) {
      people.add(`${event.cameraId || event.camera || ''}:${event.trackingId}`);
    }
    const timestamp = Date.parse(event.timestamp);
    const minute = new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString();
    const bucket = byMinute.get(minute) || { minute, people: new Set(), entries: 0, exits: 0 };
    bucket.entries += 1;
    if (event.trackingId !== null && event.trackingId !== undefined) {
      bucket.people.add(`${event.cameraId || event.camera || ''}:${event.trackingId}`);
    }
    byMinute.set(minute, bucket);
  }
  for (const event of exitEvents) {
    const timestamp = Date.parse(event.timestamp);
    const minute = new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString();
    const bucket = byMinute.get(minute) || { minute, people: new Set(), entries: 0, exits: 0 };
    bucket.exits += 1;
    byMinute.set(minute, bucket);
  }
  return {
    start,
    end,
    periodEvents,
    footfall: people.size,
    entries: entryEvents.length,
    exits: exitEvents.length,
    traffic: [...byMinute.values()]
      .sort((left, right) => left.minute.localeCompare(right.minute))
      .map(bucket => ({
        minute: bucket.minute,
        footfall: bucket.people.size,
        entries: bucket.entries,
        exits: bucket.exits,
      })),
  };
}
