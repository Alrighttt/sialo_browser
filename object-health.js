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
// Nothing here can be repaired in place from this app, and the wording says so
// rather than implying a button. indexd keys a stored sector to exactly one
// host and its pin route only ever fills a binding that is already empty, so
// re-pinning cannot repoint a shard that is still bound: the only thing that
// moves one on the storing indexer is indexd's own migrator, which selects
// slabs whose sectors are unbound or whose contracts have gone bad and rebinds
// them onto good hosts. That runs on a backoff measured in hours, so waiting is
// the correct action here and the figures below are a status report.
//
// Migrating is different, and is the one thing this app can do about it. On an
// indexer that has never seen these slabs there is no binding to preserve, so
// shards can be placed on hosts it accepts and pinned there. That is why the
// wording points at Migrate rather than at a repair that would not stick.
//
// Everything here is pure. `usableHosts` is a Set of host public keys, taken
// from `sdk.hosts()` on the indexer in question — the indexer's own
// usable-hosts query, which is the right yardstick for two reasons. Its
// contract test is character-for-character the one the pin rule applies
// (`state IN (0,1) AND renewed_to IS NULL AND good AND proof_height >
// scanned_height`), so "unusable" here means the same thing as "would be
// refused on pin" there. And usability requires `has_quic AND has_siamux`
// together, so protocol is not a variable: a host that ever held a shard
// supported both, and the wasm binding's QUIC filter narrows nothing.

/**
 * The host public keys this indexer can currently use.
 *
 * Paged, because the indexer applies a default limit of 100 when a request
 * names none and a single object can span more hosts than that; 500 is the
 * maximum limit it accepts. `country` is passed explicitly because the
 * generated type declares it present-but-undefined.
 *
 * Returns null when the list could not be fetched, which callers must treat as
 * "unknown" rather than "nothing is usable" — the difference between saying
 * nothing and condemning every shard.
 */
export async function usableHostKeys(sdk) {
  const PAGE = 500;
  const keys = new Set();
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await sdk.hosts({ country: undefined, limit: PAGE, offset });
      for (const h of page) keys.add(h.publicKey);
      if (page.length < PAGE) break;
    }
  } catch (_) {
    return null;
  }
  return keys;
}

/**
 * The byte ranges of an object that cannot be reconstructed right now, because
 * fewer than `minShards` of the slab covering them sit on usable hosts.
 *
 * This is the one download failure that is knowable in advance: a slab short of
 * its minimum will fail however it is fetched, so there is no reason to
 * transfer nine tenths of a file to find out. Each slab's `length` is its
 * contribution to the object, so the ranges are the running total.
 *
 * It is a floor on trouble, not a guarantee of success. A host can be in the
 * usable set and still not hold the sector, and a slab with enough shards on
 * paper can still fail if the transport cannot reach them — which is a
 * different problem with a different fix.
 */
export function unreadableRanges(slabs, usableHosts) {
  const list = Array.isArray(slabs) ? slabs : [];
  const out = [];
  let at = 0;
  for (let i = 0; i < list.length; i += 1) {
    const len = Number(list[i] && list[i].length) || 0;
    const h = slabHealth(list[i], usableHosts);
    if (!h.recoverable) {
      out.push({ index: i, start: at, end: at + len, usable: h.usable, need: h.need });
    }
    at += len;
  }
  return out;
}

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
          + ' cannot be migrated as it stands. Migrate moves those shards onto'
          + " hosts the destination accepts as part of copying it there.",
      };
    case 'at-risk':
      return {
        tone: 'warn',
        text: 'At risk',
        detail: `${h.bare} slab${h.bare === 1 ? '' : 's'} ${h.bare === 1 ? 'has' : 'have'}`
          + ' exactly the minimum number of shards left, so losing one more host'
          + ' makes the object unreadable. This indexer should be rebinding those'
          + ' shards on its own; if it stays this way, slab migrations may be'
          + ' turned off on it. Migrating to another indexer also rebuilds the'
          + ' thin slabs, so it is the one action available from here.',
      };
    case 'unreadable':
      return {
        tone: 'bad',
        text: 'Not currently readable',
        detail: `${h.unreadable} of ${h.slabCount} slab${h.slabCount === 1 ? '' : 's'}`
          + ' no longer has enough shards on usable hosts to reconstruct.'
          + ' Nothing can move what is no longer there, so if those hosts do not'
          + ' come back this object is gone. Keep a local copy if you have one.',
      };
    default:
      return {
        tone: 'muted',
        text: 'Unknown',
        detail: 'No slab information was returned for this object.',
      };
  }
}
