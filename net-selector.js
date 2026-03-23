// net-selector.js — Reusable network selector button group
//
// Usage:
//   import { createNetSelector } from './net-selector.js';
//   const sel = createNetSelector({
//     mode: 'single',
//     initial: 'mainnet',
//     onChange: (net) => console.log('selected:', net),
//   });
//   container.appendChild(sel.el);

const DEFAULT_LABELS = {
  mainnet: 'Mainnet',
  mainnet_v2: 'V2',
  zen: 'Zen',
};

export function createNetSelector(opts = {}) {
  const {
    mode = 'single',
    networks = ['mainnet', 'mainnet_v2', 'zen'],
    labels = {},
    initial,
    onChange,
  } = opts;

  const mergedLabels = { ...DEFAULT_LABELS, ...labels };

  // State
  let selected = mode === 'single'
    ? (initial || networks[0])
    : new Set(Array.isArray(initial) ? initial : (initial ? [initial] : []));

  // DOM
  const container = document.createElement('div');
  container.className = 'net-selector';
  container.dataset.mode = mode;

  const buttons = {};
  for (const net of networks) {
    const btn = document.createElement('button');
    btn.className = 'net-sel-btn';
    btn.dataset.net = net;
    btn.textContent = mergedLabels[net] || net;
    btn.type = 'button';
    container.appendChild(btn);
    buttons[net] = btn;
  }

  function render() {
    for (const net of networks) {
      const isActive = mode === 'single' ? selected === net : selected.has(net);
      buttons[net].classList.toggle('active', isActive);
    }
  }

  function handleClick(e) {
    const btn = e.target.closest('.net-sel-btn');
    if (!btn || btn.disabled) return;
    const net = btn.dataset.net;

    if (mode === 'single') {
      if (selected === net) return;
      selected = net;
    } else {
      if (selected.has(net)) selected.delete(net);
      else selected.add(net);
    }

    render();
    if (onChange) onChange(mode === 'single' ? selected : [...selected]);
  }

  container.addEventListener('click', handleClick);

  render();

  return {
    el: container,
    getSelected() { return mode === 'single' ? selected : [...selected]; },
    setSelected(val) {
      if (mode === 'single') selected = val;
      else selected = new Set(Array.isArray(val) ? val : [val]);
      render();
    },
    setDisabled(disabledNets) {
      for (const net of networks) {
        const dis = disabledNets.has(net);
        buttons[net].disabled = dis;
        buttons[net].style.display = dis ? 'none' : '';
      }
    },
    destroy() { container.removeEventListener('click', handleClick); },
  };
}
