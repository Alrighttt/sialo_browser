// How well an object is holding up on the indexer that stores it.
//
// An object is a list of slabs; a slab is erasure-coded into sectors, each on
// one host, and any `minShards` of them reconstruct it. So a slab's health is
// simply how many of its sectors sit on hosts the indexer can currently use,
// measured against how many it needs.
//
// Two thresholds matter, and they are not the same one:
//
//   Recoverable — at least `minShards` sectors on usable hosts. Below this the
//   data cannot be read at all.
//
//   Portable — few enough sectors on unusable hosts that another indexer would
//   accept the slab. indexd refuses to pin a slab when more than 20% of its
//   parity shards are on hosts it has no good contract with, so a slab can be
//   perfectly readable here and still be refused everywhere else. That is why
//   repairing comes before migrating: repair puts shards back onto hosts that
//   are currently good, which is what restores portability.
//
// Repair itself is not something this app can do, and the wording here says so
// rather than implying a button. indexd repairs slabs on its own: a background
// pass selects slabs with any sector that is unbound or whose contract has gone
// bad, and rebinds those sectors onto good hosts. It holds the wallet, the
// contracts and the migration key; a browser client holds none of them, and
// there is no app-API route to ask for a repair either. So the useful advice is
// what to expect and what to check, not what to press.
//
// Everything here is pure. `usableHosts` is a Set of host public keys, taken
// from `sdk.hosts()` on the indexer in question.

/** Mirrors `maxBadParityShards` in indexd's persist/postgres/sectors.go. */
export const MAX_BAD_PARITY_FRACTION = 0.2;

/**
 * Health of one slab.
 *
 * `lost` counts sectors on hosts this indexer cannot currently use. That is
 * not the same as the data being gone: the host may simply have no live
 * contract here, and another indexer might still reach it.
 */
export function slabHealth(slab, usableHosts) {
  const sectors = Array.isArray(slab && slab.sectors) ? slab.sectors : [];
  const total = sectors.length;
  const need = Number(slab && slab.minShards) || 0;
  const parity = Math.max(0, total - need);
  let usable = 0;
  for (const s of sectors) {
    if (s && usableHosts.has(s.hostKey)) usable += 1;
  }
  const lost = total - usable;
  return {
    total,
    need,
    parity,
    usable,
    lost,
    // Can it be read right now?
    recoverable: need > 0 && usable >= need,
    // How many more hosts can go before it cannot.
    headroom: usable - need,
    // Would another indexer accept it? Same rule indexd applies on pin.
    portable: lost <= MAX_BAD_PARITY_FRACTION * parity,
  };
}

/**
 * Health of a whole object, which is its worst slab: one unreadable slab makes
 * the object unreadable, and one unportable slab blocks the whole migration.
 */
export function objectHealth(slabs, usableHosts) {
  const list = Array.isArray(slabs) ? slabs : [];
  const per = list.map((s) => slabHealth(s, usableHosts));
  const hosts = new Set();
  for (const s of list) {
    for (const sec of (s && s.sectors) || []) if (sec) hosts.add(sec.hostKey);
  }

  const counted = per.length;
  const unreadable = per.filter((h) => !h.recoverable).length;
  const unportable = per.filter((h) => h.recoverable && !h.portable).length;
  // Deliberately not also requiring `portable`: a slab down to exactly its
  // minimum is the more urgent problem whether or not it is portable, and
  // gating on portability here would report the worse case as the milder one.
  const bare = per.filter((h) => h.recoverable && h.headroom === 0).length;
  // The binding constraint across every slab.
  const worstHeadroom = counted ? Math.min(...per.map((h) => h.headroom)) : null;

  let verdict = 'unknown';
  if (counted === 0) verdict = 'unknown';
  else if (unreadable > 0) verdict = 'unreadable';
  else if (bare > 0) verdict = 'at-risk';
  else if (unportable > 0) verdict = 'degraded';
  else verdict = 'healthy';

  return {
    slabCount: counted,
    per,
    hostCount: hosts.size,
    unreadable,
    unportable,
    bare,
    worstHeadroom,
    verdict,
    // The question migration actually asks.
    portable: counted > 0 && unreadable === 0 && unportable === 0,
  };
}

/**
 * A one-line verdict plus the sentence that explains what to do about it.
 * Separated from rendering so the wording lives in one place, and so the
 * repair and migrate flows can reuse it rather than inventing their own.
 */
export function healthSummary(h) {
  switch (h.verdict) {
    case 'healthy':
      return {
        tone: 'ok',
        text: 'Healthy',
        detail: `Every slab has ${h.worstHeadroom} spare shard`
          + `${h.worstHeadroom === 1 ? '' : 's'} beyond what it needs, and all of them`
          + ' would be accepted by another indexer.',
      };
    case 'degraded':
      return {
        tone: 'warn',
        text: 'Readable, but not portable',
        detail: `${h.unportable} slab${h.unportable === 1 ? '' : 's'} ${h.unportable === 1 ? 'has' : 'have'}`
          + ' too many shards on hosts this indexer can no longer use. The object'
          + ' downloads fine, but another indexer would refuse to take it, so it'
          + ' cannot be migrated until the indexer has repaired it. Repair runs on'
          + ' the indexer, not from here.',
      };
    case 'at-risk':
      return {
        tone: 'warn',
        text: 'At risk',
        detail: `${h.bare} slab${h.bare === 1 ? '' : 's'} ${h.bare === 1 ? 'has' : 'have'}`
          + ' exactly the minimum number of shards left, so losing one more host'
          + ' makes the object unreadable. The indexer should be repairing this'
          + ' already; if it stays this way, check that slab migrations are'
          + ' enabled on it.',
      };
    case 'unreadable':
      return {
        tone: 'bad',
        text: 'Not currently readable',
        detail: `${h.unreadable} of ${h.slabCount} slab${h.slabCount === 1 ? '' : 's'}`
          + ' no longer has enough shards on usable hosts to reconstruct.'
          + ' Repair cannot invent missing data — if those hosts do not come'
          + ' back, this object is gone. Keep a local copy if you have one.',
      };
    default:
      return {
        tone: 'muted',
        text: 'Unknown',
        detail: 'No slab information was returned for this object.',
      };
  }
}
