// Small SVG/HTML charts for the admin dashboard: thin marks, recessive axes,
// one tooltip per chart, a legend from two series on and a table view for
// every chart. All text goes through textContent.

const NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 8, right: 12, bottom: 24, left: 40 };

function node(tag, attributes = {}, parent = null, svg = false) {
  const element = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') element.textContent = value;
    // CSSOM, not a style attribute: the page's CSP allows no inline styles.
    else if (name === 'style') for (const [property, setting] of Object.entries(value)) element.style.setProperty(property, setting);
    else if (name === 'class') element.setAttribute('class', value);
    else element.setAttribute(name, String(value));
  }
  parent?.appendChild(element);
  return element;
}
const svgNode = (tag, attributes, parent) => node(tag, attributes, parent, true);

// 0, a round half and a round top that contains the largest value.
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find(factor => value <= factor * magnitude);
  return step * magnitude;
}

function tooltip(frame) {
  const tip = node('div', { class: 'chart-tip', role: 'status', hidden: '' }, frame);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren();
      node('div', { class: 'chart-tip-title', text: title }, tip);
      for (const row of rows) {
        const line = node('div', { class: 'chart-tip-row' }, tip);
        if (row.color) node('span', { class: 'chart-tip-key', style: { background: row.color } }, line);
        node('strong', { text: row.value }, line);
        if (row.label) node('span', { text: row.label }, line);
      }
      tip.hidden = false;
      const width = frame.clientWidth;
      tip.style.left = `${Math.min(Math.max(0, x + 12), Math.max(0, width - tip.offsetWidth))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
    },
    hide() { tip.hidden = true; }
  };
}

export function legend(parent, series, shape = 'rect') {
  if (series.length < 2) return;
  const list = node('ul', { class: 'chart-legend' }, parent);
  for (const item of series) {
    const entry = node('li', {}, list);
    node('span', { class: `chart-key chart-key-${shape}`, style: { background: item.color } }, entry);
    node('span', { text: item.label }, entry);
  }
}

export function tableView(parent, headers, rows) {
  const details = node('details', { class: 'chart-table' }, parent);
  node('summary', { text: 'Als Tabelle' }, details);
  const table = node('table', {}, details);
  const head = node('tr', {}, node('thead', {}, table));
  for (const header of headers) node('th', { text: header, scope: 'col' }, head);
  const body = node('tbody', {}, table);
  for (const row of rows) {
    const line = node('tr', {}, body);
    row.forEach((cell, index) => node(index ? 'td' : 'th', { text: cell, ...(index ? {} : { scope: 'row' }) }, line));
  }
}

function axes(plot, { width, height, top, format }) {
  for (const fraction of [0, 0.5, 1]) {
    const y = MARGIN.top + (1 - fraction) * height;
    svgNode('line', { x1: MARGIN.left, x2: MARGIN.left + width, y1: y, y2: y, class: fraction ? 'chart-grid' : 'chart-baseline' }, plot);
    svgNode('text', { x: MARGIN.left - 6, y: y + 4, 'text-anchor': 'end', class: 'chart-tick', text: format(top * fraction) }, plot);
  }
}

// Every `step`-th label fits without overlapping its neighbours.
function xLabels(plot, labels, { band, height, short }) {
  const step = Math.max(1, Math.ceil(44 / band));
  labels.forEach((label, index) => {
    if (index % step && index !== labels.length - 1) return;
    if (index !== labels.length - 1 && labels.length - 1 - index < step) return;
    svgNode('text', { x: MARGIN.left + band * (index + 0.5), y: MARGIN.top + height + 16, 'text-anchor': 'middle', class: 'chart-tick', text: short(label) }, plot);
  });
}

// A column whose data end is rounded and whose baseline end is square.
function columnPath(x, y, width, height) {
  const radius = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

export function columns(parent, { labels, series, height = 180, format = String, short = label => label, title = label => label }) {
  const figure = node('div', { class: 'chart' }, parent);
  legend(figure, series);
  const frame = node('div', { class: 'chart-frame' }, figure);
  const width = Math.max(240, frame.clientWidth || parent.clientWidth || 600);
  const plotWidth = width - MARGIN.left - MARGIN.right, plotHeight = height - MARGIN.top - MARGIN.bottom;
  const plot = svgNode('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-hidden': 'true' }, frame);
  const top = niceMax(Math.max(0, ...series.flatMap(item => item.values)));
  axes(plot, { width: plotWidth, height: plotHeight, top, format });
  const band = plotWidth / Math.max(1, labels.length);
  const barWidth = Math.max(2, Math.min(24, (band * 0.8 - 2 * (series.length - 1)) / series.length));
  const group = barWidth * series.length + 2 * (series.length - 1);
  const tip = tooltip(frame);
  labels.forEach((label, index) => {
    const left = MARGIN.left + band * index + (band - group) / 2;
    series.forEach((item, position) => {
      const value = item.values[index] || 0;
      const barHeight = value / top * plotHeight;
      if (barHeight > 0) svgNode('path', { d: columnPath(left + position * (barWidth + 2), MARGIN.top + plotHeight - barHeight, barWidth, barHeight), style: { fill: item.color } }, plot);
    });
    const hit = svgNode('rect', { x: MARGIN.left + band * index, y: MARGIN.top, width: band, height: plotHeight, class: 'chart-hit', tabindex: 0 }, plot);
    const show = () => tip.show(MARGIN.left + band * (index + 0.5), MARGIN.top + 8, title(label),
      series.map(item => ({ color: item.color, value: format(item.values[index] || 0), label: series.length > 1 ? item.label : '' })));
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => tip.hide());
    hit.addEventListener('blur', () => tip.hide());
  });
  xLabels(plot, labels, { band, height: plotHeight, short });
  tableView(figure, ['', ...series.map(item => item.label)], labels.map((label, index) => [title(label), ...series.map(item => format(item.values[index] || 0))]));
  return figure;
}

// Lines on one shared axis; gaps where a value is missing. A crosshair snaps to the nearest hour.
export function lines(parent, { labels, series, height = 200, top: fixedTop = null, format = String, short = label => label, title = label => label }) {
  const figure = node('div', { class: 'chart' }, parent);
  legend(figure, series, 'line');
  const frame = node('div', { class: 'chart-frame' }, figure);
  const width = Math.max(240, frame.clientWidth || parent.clientWidth || 600);
  const plotWidth = width - MARGIN.left - MARGIN.right, plotHeight = height - MARGIN.top - MARGIN.bottom;
  const plot = svgNode('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-hidden': 'true' }, frame);
  const values = series.flatMap(item => item.values.filter(Number.isFinite));
  const top = fixedTop ?? niceMax(Math.max(0, ...values));
  axes(plot, { width: plotWidth, height: plotHeight, top, format });
  const band = plotWidth / Math.max(1, labels.length);
  const x = index => MARGIN.left + band * (index + 0.5);
  const y = value => MARGIN.top + (1 - Math.min(value, top) / top) * plotHeight;
  for (const item of series) {
    let path = '', open = false;
    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) { open = false; return; }
      path += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      open = true;
    });
    if (path) svgNode('path', { d: path, class: 'chart-line', style: { stroke: item.color } }, plot);
    const last = item.values.findLastIndex(Number.isFinite);
    if (last >= 0) svgNode('circle', { cx: x(last), cy: y(item.values[last]), r: 4, class: 'chart-dot', style: { fill: item.color } }, plot);
  }
  const cross = svgNode('line', { y1: MARGIN.top, y2: MARGIN.top + plotHeight, class: 'chart-cross', visibility: 'hidden' }, plot);
  const hit = svgNode('rect', { x: MARGIN.left, y: MARGIN.top, width: plotWidth, height: plotHeight, class: 'chart-hit', tabindex: 0 }, plot);
  const tip = tooltip(frame);
  let focused = labels.length - 1;
  const show = index => {
    focused = Math.max(0, Math.min(labels.length - 1, index));
    cross.setAttribute('x1', x(focused)); cross.setAttribute('x2', x(focused)); cross.setAttribute('visibility', 'visible');
    tip.show(x(focused), MARGIN.top + 8, title(labels[focused]), series.map(item => ({ color: item.color, label: item.label,
      value: Number.isFinite(item.values[focused]) ? format(item.values[focused]) : '–' })));
  };
  hit.addEventListener('pointermove', event => {
    const box = plot.getBoundingClientRect();
    show(Math.floor((event.clientX - box.left - MARGIN.left) / band));
  });
  hit.addEventListener('focus', () => show(focused));
  hit.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(focused + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  const hide = () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); };
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('blur', hide);
  xLabels(plot, labels, { band, height: plotHeight, short });
  tableView(figure, ['', ...series.map(item => item.label)], labels.map((label, index) =>
    [title(label), ...series.map(item => Number.isFinite(item.values[index]) ? format(item.values[index]) : '–')]));
  return figure;
}

// Horizontal bars: one value per row, or stacked segments with a 2 px gap.
export function bars(parent, { rows, segments = null, color = 'var(--series-1)', format = String, max: fixedMax = null, colors = null }) {
  const figure = node('div', { class: 'chart' }, parent);
  if (segments) legend(figure, segments);
  const frame = node('div', { class: 'chart-frame bars' }, figure);
  const tip = tooltip(frame);
  const top = fixedMax ?? Math.max(1, ...rows.map(row => row.value));
  rows.forEach((row, index) => {
    const line = node('div', { class: 'bar-row' }, frame);
    node('span', { class: 'bar-label', text: row.label }, line);
    const track = node('span', { class: 'bar-track' }, line);
    const parts = segments ? segments.map(segment => ({ ...segment, value: row.by?.[segment.key] || 0 })) : [{ label: row.label, value: row.value, color: colors?.[index] || color }];
    for (const part of parts) {
      if (!part.value) continue;
      const fill = node('span', { class: 'bar-fill', tabindex: 0, style: { width: `${part.value / top * 100}%`, background: part.color } }, track);
      const show = () => tip.show(fill.offsetLeft + fill.offsetWidth / 2, line.offsetTop, row.label, [{ color: part.color, value: format(part.value), label: segments ? part.label : '' }]);
      fill.addEventListener('pointerenter', show);
      fill.addEventListener('focus', show);
      fill.addEventListener('pointerleave', () => tip.hide());
      fill.addEventListener('blur', () => tip.hide());
    }
    node('span', { class: 'bar-value', text: row.display ?? format(row.value) }, line);
  });
  tableView(figure, ['', ...(segments ? segments.map(segment => segment.label) : []), 'Summe'],
    rows.map(row => [row.label, ...(segments ? segments.map(segment => format(row.by?.[segment.key] || 0)) : []), row.display ?? format(row.value)]));
  return figure;
}

export function meter(parent, ratio, status) {
  const track = node('span', { class: `meter meter-${status}`, role: 'img', 'aria-hidden': 'true' }, parent);
  node('span', { class: 'meter-fill', style: { width: `${Math.min(1, Math.max(0, ratio ?? 0)) * 100}%` } }, track);
  return track;
}
