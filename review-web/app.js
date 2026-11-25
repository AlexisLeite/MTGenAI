'use strict';

const find = id => document.getElementById(id);
const el = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
};
const normalize = value => value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const codeKey = value => value.match(/^\s*(C\d+)\b/i)?.[1].toUpperCase() ?? normalize(value);
const compact = window.matchMedia('(max-width: 740px)');

let codes = new Map();
let papers = {};
let publications = {};
let introductions = {};
let activeCode = '';
let activeDocument = '';
let originCodes = null;
let selection = null;
let codeSort = 'count';
let reviewMetadata;
let snapshotStorage;
let reviewLoading = false;
let backgroundRefresh;
const knownSnapshots = new Map();

function isNew(code, study) {
  return originCodes !== null && !originCodes.get(code)?.documents.has(study);
}

function paperLink(label, url) {
  const link = el('a', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function choice(selected, action) {
  const button = el('button', undefined, 'choice');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(selected));
  button.onclick = action;
  return button;
}

function step(name, heading) {
  find('review').dataset.step = name;
  if (compact.matches && heading) find(heading).focus();
}

function compareCodeIds(a, b) {
  return a.id.localeCompare(b.id, undefined, {numeric: true});
}

function compareDocumentCounts(a, b) {
  return b.documents.size - a.documents.size || compareCodeIds(a, b);
}

function selectCode(key) {
  if (activeCode !== key) activeDocument = '';
  activeCode = key;
  for (const item of document.querySelectorAll('[data-code-key]')) {
    item.setAttribute('aria-pressed', String(item.dataset.codeKey === key));
  }
  find('documents').scrollTop = 0;
  find('evidence').scrollTop = 0;
  renderDocuments();
  renderEvidence();
  step('documents', 'document-heading');
}

function animateBarOrder(chart, exits, previous) {
  const frame = exits.getBoundingClientRect();
  for (const item of chart.querySelectorAll('.chart-code')) {
    const key = item.dataset.codeKey;
    const before = previous.get(key);
    if (!before) {
      item.animate([{opacity: 0, transform: 'translateY(6px)'}, {opacity: 1, transform: 'translateY(0)'}],
        {duration: 290, easing: 'ease-out'});
      continue;
    }
    previous.delete(key);
    const shift = before.rect.top - item.getBoundingClientRect().top;
    if (Math.abs(shift) > .5) {
      item.animate([{transform: 'translateY(' + shift + 'px)'}, {transform: 'translateY(0)'}],
        {duration: 400, easing: 'cubic-bezier(.2,.75,.25,1)'});
    }
    const bar = item.querySelector('.chart-bar');
    if (before.clip !== getComputedStyle(bar).clipPath) {
      bar.animate([{clipPath: before.clip}, {clipPath: bar.style.clipPath}],
        {duration: 400, easing: 'cubic-bezier(.2,.75,.25,1)'});
    }
  }
  for (const {item, rect, clip, opacity} of previous.values()) {
    if (rect.bottom <= frame.top || rect.top >= frame.bottom) continue;
    const copy = item.cloneNode(true);
    copy.removeAttribute('data-code-key');
    copy.querySelector('.chart-bar').style.clipPath = clip;
    Object.assign(copy.style, {
      top: rect.top - frame.top + 'px',
      left: rect.left - frame.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px'
    });
    exits.append(copy);
    const fade = copy.animate([{opacity}, {opacity: 0}], {duration: 320, easing: 'ease-out', fill: 'forwards'});
    fade.finished.then(() => copy.remove(), () => copy.remove());
  }
}

function renderBarChart() {
  const top = [...codes].filter(([, code]) => code.documents.size)
    .sort(([, a], [, b]) => compareDocumentCounts(a, b))
    .slice(0, 12);
  const details = find('code-chart');
  const chart = find('bar-chart');
  const exits = find('chart-exits');
  exits.replaceChildren();
  const animate = details.open && !details.hidden && top.length && chart.childElementCount &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches && typeof Element.prototype.animate === 'function';
  const previous = new Map();
  if (animate) {
    for (const item of chart.querySelectorAll('.chart-code')) {
      previous.set(item.dataset.codeKey, {
        item, rect: item.getBoundingClientRect(), opacity: getComputedStyle(item).opacity,
        clip: getComputedStyle(item.querySelector('.chart-bar')).clipPath
      });
    }
  }
  details.hidden = !top.length;
  const maximum = Math.max(1, reviewMetadata.chartMaximum);
  chart.setAttribute('aria-label', 'Códigos ordenados por cantidad de documentos. Ancho completo: ' + maximum + ' documentos.');
  chart.replaceChildren(...top.map(([key, code]) => {
    const item = el('li');
    const button = choice(key === activeCode, () => selectCode(key));
    button.className = 'chart-code';
    button.dataset.codeKey = key;
    const count = code.documents.size;
    button.setAttribute('aria-label', code.id + ' · ' + count + (count === 1 ? ' documento' : ' documentos'));
    const track = el('span', undefined, 'chart-track');
    const bar = el('span', undefined, 'chart-bar');
    bar.style.clipPath = 'inset(0 ' + (1 - count / maximum) * 100 + '% 0 0 round .2rem)';
    bar.setAttribute('aria-hidden', 'true');
    bar.append(el('span', code.title, 'chart-bar-title'));
    track.append(el('span', code.title, 'chart-bar-title'), bar);
    button.append(el('span', code.id, 'chart-code-id'), track, el('span', String(count), 'chart-count'));
    item.append(button);
    return item;
  }));
  if (animate) animateBarOrder(chart, exits, previous);
}

function renderCodes() {
  const list = find('codes');
  const query = normalize(find('search').value);
  const options = [...codes].filter(([, code]) => normalize([code.id, code.title, code.description].join(' ')).includes(query));
  options.sort(([, a], [, b]) => (codeSort === 'count' ? compareDocumentCounts : compareCodeIds)(a, b));
  find('code-count').textContent = query ? options.length + '/' + codes.size : codes.size;
  list.replaceChildren(...options.map(([key, code]) => {
    const button = choice(key === activeCode, () => selectCode(key));
    button.dataset.codeKey = key;
    const label = el('strong');
    label.append(el('span', code.id, 'code-id'), document.createTextNode(code.title));
    const line = el('span', undefined, 'choice-line');
    line.append(label);
    const badges = el('span', undefined, 'code-badges');
    const total = code.documents.size;
    badges.append(el('span', total + (total === 1 ? ' documento' : ' documentos'), 'badge zero'));
    if (originCodes) {
      if (!originCodes.has(key)) badges.append(el('span', 'Código nuevo', 'badge'));
      const added = [...code.documents.keys()].filter(study => isNew(key, study)).length;
      const badge = el('span', '+' + added, added ? 'badge' : 'badge zero');
      badge.title = added === 1 ? '1 documento nuevo' : added + ' documentos nuevos';
      badge.setAttribute('aria-label', badge.title);
      badges.append(badge);
    }
    line.append(badges);
    button.append(line, el('span', code.description, 'description'));
    return button;
  }));
  if (!options.length) list.append(el('p', 'No hay códigos para mostrar.', 'empty'));
}

function renderDocuments() {
  const code = codes.get(activeCode);
  const list = find('documents');
  find('document-heading').textContent = code ? code.id + ' · ' + code.title : 'Detalles del código';
  find('selected-code-description').textContent = code?.description ?? '';
  find('document-controls').hidden = !code;
  const order = find('document-sort').value;
  const documents = code ? [...code.documents.keys()].sort((a, b) => {
    if (order === 'date') {
      const comparison = (publications[b]?.date ?? '').localeCompare(publications[a]?.date ?? '');
      if (comparison) return comparison;
    } else if (order === 'version') {
      const comparison = (introductions[a] ?? Infinity) - (introductions[b] ?? Infinity);
      if (comparison) return comparison;
    }
    return a.localeCompare(b, undefined, {numeric: true});
  }) : [];
  list.replaceChildren(...documents.map(study => {
    const button = choice(study === activeDocument, () => {
      activeDocument = study;
      list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      find('evidence').scrollTop = 0;
      renderEvidence();
      step('evidence', 'evidence-heading');
    });
    const line = el('span', undefined, 'choice-line');
    line.append(el('span', study + '.pdf'));
    if (isNew(activeCode, study)) line.append(el('span', 'Nuevo', 'badge'));
    button.append(line);
    const metadata = [publications[study] ? formatPublication(publications[study].date) : 'Sin fecha'];
    if (introductions[study]) metadata.push('Versión ' + introductions[study]);
    button.append(el('span', metadata.join(' · '), 'document-metadata'));
    return button;
  }));
  if (!documents.length) {
    list.append(el('p', code ? 'Sin evidencia registrada.' : 'Elegí un código.', 'empty'));
  }
}

function formatPublication(date) {
  const [, month, day] = date.split('-');
  const options = {year: 'numeric', timeZone: 'UTC'};
  if (month) options.month = 'long';
  if (day) options.day = 'numeric';
  return new Intl.DateTimeFormat('es-UY', options)
    .format(new Date(date + (day ? '' : month ? '-01' : '-01-01')));
}

function renderEvidence() {
  document.dispatchEvent(new Event('review-context'));
  const items = codes.get(activeCode)?.documents.get(activeDocument) ?? [];
  const heading = find('selected-document');
  heading.textContent = activeDocument ? activeDocument + '.pdf' : '';
  const publication = publications[activeDocument];
  if (publication) {
    const time = el('time', formatPublication(publication.date));
    time.dateTime = publication.date;
    heading.append(' · ', time);
    if (publication.type) heading.append(' · ', publication.type);
  }
  const panel = find('evidence');
  panel.replaceChildren(...items.map(item => {
    const card = el('article', undefined, 'evidence-card');
    card.append(el('p', 'Página ' + (item.Page || 'N/A'), 'page'), el('blockquote', item['Evidence Quote']));
    if (Object.hasOwn(papers, activeDocument)) {
      const links = el('p', undefined, 'paper-links');
      const page = item.Page.trim().match(/^(?:p\.?\s*)?([1-9][0-9]*)(?:\s*[-–]\s*[1-9][0-9]*)?$/i)?.[1];
      if (page) links.append(paperLink('Abrir PDF en página ' + page, './papers/' + activeDocument + '.pdf#page=' + page));
      links.append(paperLink('Ver en Drive', papers[activeDocument]));
      card.append(links);
    }
    if (item.Justification || item.Context) {
      const details = el('div', undefined, 'evidence-details');
      for (const [label, value] of [['Justificación', item.Justification], ['Contexto', item.Context]]) {
        if (!value) continue;
        const block = el('p');
        block.append(el('strong', label + ' · '), document.createTextNode(value));
        details.append(block);
      }
      card.append(details);
    }
    return card;
  }));
  if (!items.length) panel.append(el('p', 'Elegí un documento.', 'empty'));
}

function reviewContext() {
  const selected = codes.get(activeCode);
  return {code: selected?.id, title: selected?.title, document: activeDocument || undefined};
}

function indexCodes(data) {
  const index = new Map(data.codes.map(row => [
    codeKey(row['Code ID']),
    {id: row['Code ID'], title: row.Code, description: row.Description, documents: new Map()}
  ]));
  const titles = new Map([...index.values()].map(code => [normalize(code.title), code]));
  for (const item of data.coding) {
    const code = index.get(codeKey(item.Challenge)) ?? titles.get(normalize(item.Challenge));
    if (!code || !item.StudyID.trim() || !item['Evidence Quote'].trim()) continue;
    const study = item.StudyID.trim().toUpperCase();
    const items = code.documents.get(study) ?? [];
    items.push(item);
    code.documents.set(study, items);
  }
  return index;
}

function render(data) {
  codes = indexCodes(data);
  originCodes = data.origin ? indexCodes(data.origin) : null;
  papers = data.papers;
  publications = data.publications;
  introductions = data.introductions ?? {};
  if (!codes.has(activeCode)) activeCode = '';
  if (!codes.get(activeCode)?.documents.has(activeDocument)) activeDocument = '';
  step(!activeCode ? 'codes' : activeDocument ? 'evidence' : 'documents');
  renderCodes();
  renderBarChart();
  renderDocuments();
  renderEvidence();
}

function renderVersions() {
  if (!selection) return;
  const {versions, version, originVersion} = selection;
  const index = versions.indexOf(version);
  find('previous-version').disabled = index <= 0;
  find('next-version').disabled = index < 0 || index === versions.length - 1;
  find('current-version').textContent = 'Versión ' + version + (originVersion ? ' · vs. ' + originVersion : '');
}

function moveVersion(offset) {
  if (!selection || reviewLoading) return;
  const {versions, version} = selection;
  const next = versions[versions.indexOf(version) + offset];
  if (next !== undefined) loadReview(next);
}

function previousComparison(version) {
  return reviewMetadata.versions.includes(version - 1) ? version - 1 : 0;
}

function browserSnapshotCache() {
  snapshotStorage ??= window.caches?.open('codebook-versiones-v1').catch(() => null) ?? Promise.resolve(null);
  return snapshotStorage;
}

function snapshotURL(key) {
  return new URL('./api/review?cachedVersion=' + key, document.baseURI);
}

function rememberSnapshot(snapshot, key = reviewMetadata.snapshotKeys[snapshot.version]) {
  if (!key) return;
  const value = {version: snapshot.version, codes: snapshot.codes, coding: snapshot.coding,
    introductions: snapshot.introductions};
  if (knownSnapshots.has(key)) return;
  knownSnapshots.set(key, value);
  browserSnapshotCache().then(cache => cache?.put(snapshotURL(key), new Response(JSON.stringify(value))))
    .catch(() => {});
}

async function cachedSnapshot(version, metadata = reviewMetadata) {
  const key = metadata.snapshotKeys[version];
  if (!key) return null;
  if (knownSnapshots.has(key)) return knownSnapshots.get(key);
  try {
    const cache = await browserSnapshotCache();
    const response = await cache?.match(snapshotURL(key));
    const snapshot = await response?.json();
    if (snapshot?.version === version && Array.isArray(snapshot.codes) && Array.isArray(snapshot.coding)) {
      knownSnapshots.set(key, snapshot);
      return snapshot;
    }
  } catch {
    // Storage can be unavailable in a private window or when the quota is full.
  }
  return null;
}

function showReview(destination, origin) {
  render({...reviewMetadata, ...destination, origin});
  selection = {versions: reviewMetadata.versions, version: destination.version, originVersion: origin?.version ?? 0};
  showPendingVersions();
}

function showPendingVersions() {
  const status = find('status');
  status.classList.remove('error');
  status.hidden = !reviewMetadata.pending.length;
  if (!status.hidden) status.textContent = 'Versiones pendientes: ' + reviewMetadata.pending.join(', ');
}

async function fetchReviewData(params) {
  const response = await fetch('./api/review?' + params, {cache: 'no-store'});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo leer Drive.');
  return data;
}

function updateReviewMetadata(data) {
  const {versions, pending, snapshotKeys, papers, publications, chartMaximum} = data;
  reviewMetadata = {versions, pending, snapshotKeys, papers, publications, chartMaximum};
}

async function loadReviewData(params) {
  const data = await fetchReviewData(params);
  updateReviewMetadata(data);
  return data;
}

async function hasSavedVersions() {
  try {
    const cache = await browserSnapshotCache();
    return (await cache?.keys())?.length > 0;
  } catch {
    return false;
  }
}

async function loadReview(destination = null) {
  reviewLoading = true;
  const status = find('status');
  const navigation = find('version-navigation');
  navigation.setAttribute('aria-busy', 'true');
  try {
    if (destination === null && await hasSavedVersions()) {
      const manifest = await loadReviewData(new URLSearchParams({manifest: 1}));
      destination = manifest.version;
    }
    if (reviewMetadata && destination !== null) {
      const origin = previousComparison(destination);
      const [next, base] = await Promise.all([cachedSnapshot(destination), origin ? cachedSnapshot(origin) : null]);
      if (next && (!origin || base)) {
        showReview(next, base);
        return;
      }
    }
    status.hidden = false;
    status.classList.remove('error');
    status.textContent = 'Cargando…';
    const params = new URLSearchParams();
    if (destination !== null) params.set('destination', destination);
    const data = await loadReviewData(params);
    rememberSnapshot(data);
    if (data.origin) rememberSnapshot(data.origin);
    showReview(data, data.origin);
  } catch (error) {
    status.hidden = false;
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    reviewLoading = false;
    navigation.removeAttribute('aria-busy');
    renderVersions();
  }
}

async function prefetchVersions(metadata) {
  // Check the browser cache before asking for version data.
  const numbers = [...metadata.versions].reverse();
  const cached = await Promise.all(numbers.map(number => cachedSnapshot(number, metadata)));
  const missing = numbers.filter((_, index) => !cached[index]);
  for (let index = 0; index < missing.length; index += 4) {
    const params = new URLSearchParams({snapshots: missing.slice(index, index + 4).join(',')});
    const data = await fetchReviewData(params);
    for (const snapshot of data.snapshots) rememberSnapshot(snapshot, snapshot.key);
  }
}

async function refreshCatalog() {
  const data = await fetchReviewData(new URLSearchParams({manifest: 1}));
  if (reviewLoading || !selection) return;
  const previous = reviewMetadata;
  updateReviewMetadata(data);
  const {version, originVersion} = selection;
  const keys = data.snapshotKeys;
  if (!keys[version] || keys[version] !== previous.snapshotKeys[version] ||
      originVersion !== previousComparison(version) ||
      (originVersion && keys[originVersion] !== previous.snapshotKeys[originVersion])) {
    await loadReview(keys[version] ? version : data.version);
    return;
  }
  if (selection.versions.join(',') !== data.versions.join(',')) {
    selection.versions = data.versions;
    renderVersions();
  }
  showPendingVersions();
  if (previous.chartMaximum !== data.chartMaximum) renderBarChart();
  if (JSON.stringify([papers, publications]) !== JSON.stringify([data.papers, data.publications])) {
    ({papers, publications} = data);
    renderDocuments();
    renderEvidence();
  }
}

function refreshVersionCache(checkDrive) {
  if (!selection || reviewLoading || backgroundRefresh || document.hidden) return;
  backgroundRefresh = (async () => {
    if (checkDrive) await refreshCatalog();
    await prefetchVersions(reviewMetadata);
  })().catch(() => {
    // A transient failure leaves the current view usable; the next poll retries.
  }).finally(() => {
    backgroundRefresh = undefined;
  });
}

find('previous-version').onclick = () => moveVersion(-1);
find('next-version').onclick = () => moveVersion(1);
find('document-sort').onchange = () => {
  renderDocuments();
  find('documents').scrollTop = 0;
};
find('search').addEventListener('input', renderCodes);
find('code-sort').onclick = () => {
  codeSort = codeSort === 'count' ? 'id' : 'count';
  find('code-sort').textContent = codeSort === 'count' ? 'Orden: cantidad ↓' : 'Orden: ID ↑';
  renderCodes();
  find('codes').scrollTop = 0;
};
for (const button of document.querySelectorAll('[data-back]')) {
  button.onclick = () => step(button.dataset.back, button.dataset.back === 'codes' ? 'search' : 'document-heading');
}
loadReview().then(() => refreshVersionCache(false));
setInterval(() => refreshVersionCache(true), 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshVersionCache(true);
});
