// The Migrate prompt for My Objects.
//
// Migration copies an object onto another indexer without re-uploading it. What
// makes that possible is that indexd's slab digest covers each sector's root and
// the slab's parameters but never the host keys, so a shard that changes host
// leaves the digest, and therefore the object ID, untouched. Links, sites and
// sharing keys pointing at the object keep resolving.
//
// The destination decides what needs doing, not the source. A shard sitting on
// a host the destination holds no good contract with is one its pin rule counts
// against the slab, and it refuses a slab once more than a fifth of the parity
// shards are like that. So "repair" here means moving those shards onto hosts
// the destination will accept, and it is a step inside migration rather than a
// thing worth doing on its own: on the indexer that already holds the object,
// the sector rows are bound and re-pinning cannot repoint them.
//
// The source keeps its own pin. This makes the object available on the
// destination; removing it from the source is a separate decision, offered once
// the copy is verified rather than folded in silently.
//
// The layout follows the sharing-key prompt in `sharing-keys.js`: same shell,
// same section rule, same button treatment, so the dialogs in My Objects feel
// like one family.

import { _esc, formatSize } from './utils.js';
import { otherProfiles, connectProfile } from './config.js';

const ACCENT = '#d97706';
const TONE = { ok: '#4ade80', warn: '#f59e0b', bad: '#f87171', muted: '#888' };

/** The shell, so the dialog never jumps size between steps. */
function shell(bodyHtml) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000;';
  modal.innerHTML = `
    <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:560px; width:90%; max-height:85vh; overflow:auto; border:1px solid #333;">
      ${bodyHtml}
    </div>
  `;
  return modal;
}

/**
 * Where the object stands *as the destination sees it*, which is the only view
 * that decides whether a migration is accepted.
 *
 * `readable` and `portable` come from the SDK rather than being recomputed
 * here, so the threshold lives in one place.
 */
function verdict(health, source, sameIndexer) {
  // Readability is the source's question, not the destination's. Shards are
  // read through the indexer that knows where they live, so a destination that
  // cannot reach `minShards` of a slab is describing work to do, not an
  // impossibility — repair reconstructs through the source and places the
  // result on hosts both can see. Only the source being unable to read it
  // means the data is actually gone.
  if (!source.readable) {
    return {
      tone: 'bad',
      text: 'Cannot be migrated',
      detail: `${source.unreadableSlabs} of ${source.slabs.length} slab`
        + `${source.slabs.length === 1 ? '' : 's'} has too few shards left on any`
        + ' reachable host to reconstruct. Nothing can move what is no longer'
        + ' there.',
      blocked: true,
    };
  }
  // Two accounts on one indexer share everything that decides this. Slabs and
  // sectors are keyed by digest and root with no account column, and the
  // good-host set comes from the indexer's own contracts with no account
  // filter — so the destination's view of the object is the source's view,
  // and there is nothing to move anywhere. What the second account lacks is
  // its own pin rows, which is all a pin writes.
  if (sameIndexer && health.portable) {
    return {
      tone: 'ok',
      text: 'Ready to pin',
      detail: 'Same indexer, different account. The shards are already where'
        + ' this account would want them, so nothing is read, rebuilt or'
        + ' uploaded — it just takes ownership of the same data. Storage is'
        + ' billed to the destination account from now on.',
      sameIndexer: true,
    };
  }
  if (sameIndexer) {
    return {
      tone: 'warn',
      text: 'Needs repairing first',
      detail: `${health.unportableSlabs} slab${health.unportableSlabs === 1 ? '' : 's'}`
        + ` ${health.unportableSlabs === 1 ? 'has' : 'have'} lost too many shards for this`
        + ' indexer to accept a fresh pin, even though the account that already'
        + ' holds the object keeps it: the limit is checked when a pin is'
        + ' written, not afterwards. Repairing rebuilds those shards onto hosts'
        + ' it holds contracts with, after which the pin goes through.',
      sameIndexer: true,
    };
  }
  if (!health.readable) {
    return {
      tone: 'warn',
      text: 'Needs repairing first',
      detail: `${health.unreadableSlabs} of ${health.slabs.length} slab`
        + `${health.slabs.length === 1 ? '' : 's'} ${health.unreadableSlabs === 1 ? 'has' : 'have'}`
        + ' too few shards on hosts this destination knows for it to reconstruct'
        + ' them, so it cannot take the object as it stands. This indexer can'
        + ' still read them, so repairing rebuilds those slabs onto hosts both'
        + ' indexers know — after which the destination can take it.',
      repairFirst: true,
    };
  }
  if (!health.portable) {
    return {
      tone: 'warn',
      text: 'Needs shards moved first',
      detail: `${health.unportableSlabs} slab${health.unportableSlabs === 1 ? '' : 's'}`
        + ` ${health.unportableSlabs === 1 ? 'has' : 'have'} too many shards on hosts this`
        + ' destination holds no contract with, so it would refuse them. Moving'
        + ' those shards onto hosts it does accept is what migration does'
        + ' before pinning.',
    };
  }
  if (health.needsRepair) {
    return {
      tone: 'warn',
      text: 'Ready, with shards worth moving',
      detail: 'Every slab would already be accepted, but some shards sit on'
        + ' hosts this destination cannot reach. Moving them buys back'
        + ' redundancy on the new indexer.',
    };
  }
  return {
    tone: 'ok',
    text: 'Ready to migrate',
    detail: 'Every shard is already on a host this destination accepts, so'
      + ' nothing needs moving — only the pin.',
  };
}

function tally(health) {
  const total = health.slabs.reduce((n, s) => n + s.totalShards, 0);
  const bad = health.slabs.reduce((n, s) => n + s.badShards, 0);
  // `movesRequired` comes from the SDK rather than being derived from `bad`
  // here. The two are very different numbers — a destination tolerates a fifth
  // of each slab's parity shards being elsewhere — and deriving it in the UI is
  // how a dialog ends up promising a thousand shards for work that moves six
  // hundred.
  return { total, bad, usable: total - bad, moving: health.movesRequired };
}

/**
 * Offers to migrate `obj` to another configured indexer, and carries it through.
 *
 * Resolves to the destination profile when the object was pinned there, and to
 * null when the user declined or nothing could be done — so callers can report
 * success on a non-null result and stay quiet otherwise.
 */
export async function migrateObjectPrompt(sourceSdk, obj, subject) {
  const profiles = otherProfiles();

  return new Promise((resolve) => {
    const modal = shell(`
      <h3 style="margin:0 0 0.25rem 0; color:${ACCENT};">Migrate object</h3>
      <p style="color:#888; margin:0 0 1.25rem 0; font-size:0.9rem;">${_esc(subject || '')}</p>

      <div id="mg-pick">
        <div style="color:#e0e0e0; margin-bottom:0.5rem; font-weight:500;">Copy to which profile?</div>
        <div id="mg-list" style="margin-bottom:0.75rem;"></div>
        <div style="color:#666; font-size:0.8rem; line-height:1.5;">
          The object keeps the same ID and its data is not re-uploaded: shards
          already on hosts the destination accepts are left where they are. It
          stays on the profile you are on too &mdash; removing it there is a
          separate step. A profile is an account, so a destination can be
          another account on the same indexer.
        </div>
      </div>

      <div id="mg-check" style="display:none; color:#888; font-size:0.9rem;">Asking the destination what it makes of this object…</div>

      <div id="mg-plan" style="display:none;"></div>

      <div id="mg-progress" style="display:none; border-top:1px solid #333; padding-top:1rem; margin-bottom:1.25rem;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.4rem;">
          <span id="mg-phase" style="color:#e0e0e0; font-size:0.9rem;">Migrating…</span>
          <span id="mg-count" style="color:#888; font-size:0.8rem; font-variant-numeric:tabular-nums;"></span>
        </div>
        <progress id="mg-bar" value="0" max="1" style="width:100%; height:0.5rem; display:block;"></progress>
        <div id="mg-current" style="color:#9aa3ad; font-size:0.8rem; margin-top:0.5rem; line-height:1.5; min-height:2.4em;"></div>
        <div id="mg-tally" style="color:#666; font-size:0.8rem; margin-top:0.25rem; font-variant-numeric:tabular-nums;"></div>
      </div>

      <div id="mg-result" style="display:none; border-top:1px solid #333; padding-top:1rem; margin-bottom:1.25rem;"></div>

      <div style="display:flex; gap:0.5rem; margin-top:1.25rem;">
        <button id="mg-go" style="display:none; flex:1; padding:0.75rem; background:${ACCENT}; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:500;">Migrate</button>
        <button id="mg-close" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
        <button id="mg-bg" style="display:none; flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Run in background</button>
      </div>
    `);
    document.body.appendChild(modal);

    const q = (sel) => modal.querySelector(sel);
    let outcome = null;
    let running = false;
    let hidden = false;
    const done = () => { modal.remove(); resolve(outcome); };
    // While a migration is in flight the dialog is the only place its progress
    // is shown, so a stray backdrop click must not throw it away. Dismissing is
    // offered explicitly by "Run in background".
    modal.addEventListener('click', (e) => { if (e.target === modal && !running) done(); });
    q('#mg-close').addEventListener('click', () => { if (!running) done(); });
    q('#mg-bg').addEventListener('click', () => { hidden = true; modal.remove(); });

    const list = q('#mg-list');
    if (!profiles.length) {
      list.innerHTML = '<div style="color:#888; font-size:0.9rem;">'
        + 'No other indexer is configured. Add one on the Configuration page first.'
        + '</div>';
      return;
    }
    for (const profile of profiles) {
      const item = document.createElement('button');
      item.style.cssText = 'display:block; width:100%; text-align:left; padding:0.6rem 0.75rem; margin-bottom:0.4rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; cursor:pointer;';
      item.innerHTML = `
        <div style="font-weight:500;">${_esc(profile.name)}</div>
        <div style="font-size:0.8rem; color:#666;">${_esc(profile.url)}${profile.sameIndexer
          // With two profiles on one indexer the URL alone names them both, so
          // it cannot be what tells them apart. Say which is which, and say
          // the thing that actually matters about this one.
          ? ' &middot; <span style="color:#34d399;">same indexer, another account &mdash; nothing to move</span>'
          : ''}</div>
      `;
      item.addEventListener('click', () => start(profile));
      list.appendChild(item);
    }

    async function start(profile) {
      q('#mg-pick').style.display = 'none';
      q('#mg-check').style.display = '';

      let dstSdk;
      try {
        dstSdk = await connectProfile(profile);
      } catch (e) {
        return fail(`Could not reach ${profile.name}: ${e.message || e}`);
      }
      if (!dstSdk) {
        return fail(`${profile.name} did not recognise its app key. Register or log in on that indexer first.`);
      }

      // Asked of the destination, not the source: its host list is what decides
      // whether the pin is accepted.
      let health;
      let sourceHealth;
      try {
        health = dstSdk.objectHealth(obj);
        // Asked of the source as well, because the two answer different
        // questions: what the destination will accept, and what can still be
        // read at all.
        sourceHealth = sourceSdk.objectHealth(obj);
      } catch (e) {
        return fail(`Could not assess the object against ${profile.name}: ${e.message || e}`);
      }

      const v = verdict(health, sourceHealth, !!profile.sameIndexer);
      const { total, bad, usable, moving } = tally(health);
      q('#mg-check').style.display = 'none';
      q('#mg-plan').style.display = '';
      q('#mg-plan').innerHTML = `
        <div style="background:#0a0a0a; border:1px solid #333; border-radius:6px; padding:1rem; margin-bottom:1.25rem;">
          <div style="color:${TONE[v.tone]}; font-weight:600; margin-bottom:0.35rem;">${_esc(v.text)}</div>
          <div style="color:#bbb; font-size:0.85rem; line-height:1.5;">${_esc(v.detail)}</div>
          <div style="color:#9aa3ad; font-size:0.8rem; line-height:1.6; margin-top:0.6rem;">
            ${v.sameIndexer
              // "accepts N of M shards" would be comparing the indexer with
              // itself. What is worth stating instead is the size of what is
              // about to be shared rather than copied.
              ? `${health.slabs.length} slab${health.slabs.length === 1 ? '' : 's'},
                 ${total} shard${total === 1 ? '' : 's'}, already stored on this indexer.
                 ${moving ? `${moving} need${moving === 1 ? 's' : ''} rebuilding first.` : 'None are moving.'}`
              : `${_esc(profile.name)} accepts ${usable} of ${total} shards as they stand,
                 across ${health.slabs.length} slab${health.slabs.length === 1 ? '' : 's'}.
                 ${moving
                   ? `${moving} shard${moving === 1 ? '' : 's'} would move — the ${bad - moving} others
                      sit on hosts it does not know but are within what it tolerates.`
                   : bad
                     ? `Nothing would move: all ${bad} shards on hosts it does not know are within
                        what it tolerates.`
                     : ''}`}
          </div>
        </div>
      `;
      if (v.blocked) {
        q('#mg-close').textContent = 'Close';
        return;
      }
      const go = q('#mg-go');
      go.style.display = '';
      // Named for the work rather than the outcome when there is work: the
      // repair is the slow part and the pin that follows it is instant, and a
      // button promising a migration hides where the time goes.
      go.textContent = !moving
        ? 'Pin on ' + profile.name
        : v.repairFirst
          ? `Repair ${moving} shard${moving === 1 ? '' : 's'}, then migrate`
          : `Move ${moving} shard${moving === 1 ? '' : 's'} and pin`;
      go.addEventListener('click', () => run(profile, dstSdk), { once: true });
    }

    function fail(message) {
      q('#mg-check').style.display = 'none';
      q('#mg-result').style.display = '';
      q('#mg-result').innerHTML = `
        <div style="color:${TONE.bad}; font-weight:600; margin-bottom:0.35rem;">Migration did not start</div>
        <div style="color:#bbb; font-size:0.85rem; line-height:1.5;">${_esc(message)}</div>
      `;
      q('#mg-close').textContent = 'Close';
    }

    async function run(profile, dstSdk) {
      running = true;
      q('#mg-go').style.display = 'none';
      q('#mg-close').style.display = 'none';
      q('#mg-bg').style.display = '';
      q('#mg-plan').style.display = 'none';
      q('#mg-progress').style.display = '';

      const seen = { moved: 0, rebuilt: 0, failed: 0 };
      try {
        const migrated = await dstSdk.migrateObject(obj, sourceSdk, (e) => {
          // The dialog may be gone; the migration carries on regardless.
          const bar = q('#mg-bar');
          if (!bar) return;
          bar.max = e.total || 1;
          bar.value = e.done;
          q('#mg-count').textContent = `${e.done} of ${e.total} shards`;
          const where = `slab ${e.slabIndex + 1}, shard ${e.shardIndex + 1}`;
          if (e.kind === 'shardStarted') {
            // Deliberately not naming an outcome: whether this becomes a copy
            // or a rebuild is not known until its host either serves the
            // sector or does not.
            q('#mg-current').textContent = `Working on ${where}…`;
          } else {
            const o = e.outcome || {};
            if (o.kind === 'moved') seen.moved += 1;
            else if (o.kind === 'rebuilt') seen.rebuilt += 1;
            else if (o.kind === 'failed') seen.failed += 1;
            q('#mg-current').textContent =
              o.kind === 'moved' ? `Copied ${where} to a host ${profile.name} accepts.`
              : o.kind === 'rebuilt' ? `Rebuilt ${where} from the rest of its slab.`
              : o.kind === 'failed' ? `Could not move ${where}: ${o.reason || 'no reason given'}`
              : '';
            const parts = [];
            if (seen.moved) parts.push(`${seen.moved} copied`);
            if (seen.rebuilt) parts.push(`${seen.rebuilt} rebuilt`);
            if (seen.failed) parts.push(`${seen.failed} failed`);
            q('#mg-tally').textContent = parts.join(' · ');
          }
        });

        // Verified by reading the object back from the destination rather than
        // trusting what we were handed: persistence is the whole question, and
        // it is exactly what the same-indexer path used to get wrong.
        const phase = q('#mg-phase');
        if (phase) phase.textContent = 'Confirming with ' + profile.name + '…';
        const fetched = await dstSdk.object(obj.id());
        const after = dstSdk.objectHealth(fetched);
        outcome = profile;
        q('#mg-result').innerHTML = summary(migrated, after, profile, obj);
      } catch (e) {
        q('#mg-result').innerHTML = `
          <div style="color:${TONE.bad}; font-weight:600; margin-bottom:0.35rem;">Migration failed</div>
          <div style="color:#bbb; font-size:0.85rem; line-height:1.5;">${_esc(e.message || String(e))}</div>
          <div style="color:#666; font-size:0.8rem; margin-top:0.5rem;">
            The object is untouched on this indexer.
          </div>
        `;
      } finally {
        running = false;
        if (hidden) {
          resolve(outcome);
        } else {
          q('#mg-progress').style.display = 'none';
          q('#mg-bg').style.display = 'none';
          q('#mg-result').style.display = '';
          q('#mg-close').style.display = '';
          q('#mg-close').textContent = 'Close';
        }
      }
    }
  });
}

/** What happened, in the order a person cares about. */
function summary(migrated, after, profile, obj) {
  const parts = [];
  if (migrated.moved) parts.push(`${migrated.moved} shard${migrated.moved === 1 ? '' : 's'} copied to a new host`);
  if (migrated.rebuilt) parts.push(`${migrated.rebuilt} rebuilt from the rest of ${migrated.rebuilt === 1 ? 'its' : 'their'} slab`);
  if (migrated.failed) parts.push(`${migrated.failed} could not be moved`);
  if (!parts.length) parts.push('nothing needed moving');

  const tone = migrated.failed ? 'warn' : 'ok';
  return `
    <div style="color:${TONE[tone]}; font-weight:600; margin-bottom:0.35rem;">
      ${migrated.failed ? 'Migrated, with shards left behind' : 'Migrated'}
    </div>
    <div style="color:#bbb; font-size:0.85rem; line-height:1.5;">${_esc(parts.join(' · '))}.</div>
    <div style="color:#9aa3ad; font-size:0.8rem; line-height:1.6; margin-top:0.6rem;">
      ${_esc(profile.name)} now holds this object under the same ID
      (${_esc(obj.id().slice(0, 8))}…), confirmed by reading it back.
      ${after.portable
        ? ' Every slab there is healthy.'
        : ' Some slabs there are still short of what a further migration would need.'}
    </div>
    <div style="color:#666; font-size:0.78rem; line-height:1.5; margin-top:0.6rem;">
      It is still pinned on this indexer as well, so it is stored — and billed —
      in both places. Delete it here from My Objects once you are satisfied with
      the copy.
    </div>
  `;
}
