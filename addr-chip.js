// The address-bar chip: names what kind of address the bar is showing, and
// hands over the link you would actually pass to someone else.
//
// A key-backed site's address is a bare 64-hex seed. On its own that says
// nothing — not that it is a site, not that it came from a sharing key, and
// not how to pass it on. Someone who opened a link and wants to forward it has
// to know that the seed goes in a `#sharing_key=` fragment, which is not
// something the address bar should expect them to know.
//
// Lives in its own module rather than in tabs.js because building the links
// needs sharing-keys.js and sia-site.js, and sia-site.js imports tabs.js —
// putting it there would close an import cycle. tabs.js announces address
// changes with an event and this listens, so tabs.js stays dependency-free.

import { siteLink } from './sharing-keys.js';
import { publishedSiteLink, parseSiteUrl } from './sia-site.js';
import { isSiteAddress } from './object-input.js';

/**
 * What the bar is currently showing, or null when it is nothing worth
 * labelling (an internal page, an empty bar, a bare object ID).
 *
 * `copy` is what belongs on the clipboard: for a shared site the app link that
 * opens it, not the raw address, because the address alone is not something a
 * recipient can use.
 */
function classify(url) {
  const value = String(url || '').trim();
  if (!value) return null;

  // `parseSiteUrl` is purely structural: it happily splits `sialo://download`
  // into a site id, because app pages and content share the scheme. Gate on
  // the address *shape* so a page never gets labelled as content.
  const site = isSiteAddress(value) ? parseSiteUrl(value) : null;
  if (site) {
    // A 64-hex site id is a sharing-key seed. (It could in principle be a
    // legacy manifest object id — they are indistinguishable by inspection —
    // but the seed reading is the one that is handed out as a link, and
    // getSite() resolves it that way first.)
    if (/^[0-9a-f]{64}$/i.test(site.siteId)) {
      return {
        label: 'shared',
        kind: 'shared',
        title: 'A site opened from a sharing key. Click to copy the link that opens it.',
        copy: () => siteLink(site.siteId.toLowerCase(), site.path === '/' ? '' : site.path),
      };
    }
    return {
      label: 'published site',
      kind: 'published',
      title: 'A published site. Click to copy a link that opens it.',
      copy: () => publishedSiteLink(value),
    };
  }

  if (/^sia:\/\//i.test(value)) {
    return {
      label: 'published',
      kind: 'published',
      title: 'A published object, resolved with the viewer\'s own account. Click to copy.',
      copy: () => value,
    };
  }
  return null;
}

export function initAddrChip() {
  const chip = document.getElementById('chrome-addr-chip');
  if (!chip) return;
  let current = null;
  let resetTimer = null;

  function render(url) {
    current = classify(url);
    if (!current) {
      chip.style.display = 'none';
      return;
    }
    chip.style.display = '';
    chip.textContent = current.label;
    chip.title = current.title;
    // One chip, two meanings: green for a capability someone granted you, and
    // a neutral colour for content that resolves through your own account.
    // Distinguishable at a glance without reading the label.
    chip.classList.toggle('addr-chip--published', current.kind === 'published');
  }

  chip.addEventListener('click', async () => {
    if (!current) return;
    const link = current.copy();
    const label = current.label;
    try {
      await navigator.clipboard.writeText(link);
      chip.textContent = 'copied';
    } catch (_) {
      // Clipboard access can be denied; say so rather than appearing to work.
      chip.textContent = 'copy failed';
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      // Only restore if the bar has not moved on in the meantime.
      if (current && current.label === label) chip.textContent = label;
    }, 1200);
  });

  window.addEventListener('address-changed', (e) => {
    render(e && e.detail ? e.detail.url : '');
  });

  // The first paint happens before any navigation event fires.
  const bar = document.getElementById('chrome-address-bar');
  render(bar ? bar.value : '');
}
