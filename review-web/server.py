"""Serve the review dashboard and discover matching versions in Google Drive."""
import asyncio
import csv
import io
import json
import logging
import re
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import date
from hashlib import sha256
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import NamedTemporaryFile
import threading
import time
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from paper_search import INDEX, download, update_index
from research_chat import run_chat

ROOT = Path(__file__).resolve().parent
FOLDER = '1sNnbTfuPq0veqOpM7087WB7csSQs2dmf'
FOLDER_VIEW = f'https://drive.google.com/embeddedfolderview?id={FOLDER}'
PAPERS_VIEW = 'https://drive.google.com/embeddedfolderview?id=1H9cmwDFcH8H6e-8v0rtjGL6I6CFPmW-y'
SHEET = 'https://docs.google.com/spreadsheets/d/'
PUBLICATIONS = {'id': '13wfSLKHSSJFc03K17m0l1znK2GP6XL7bEBRmo3aOfB8',
                'title': 'Codex Fechas de publicación'}
SHEET_ID = re.compile(r'https://docs\.google\.com/spreadsheets/d/([\w-]+)/')
PDF_ID = re.compile(r'https://drive\.google\.com/file/d/([\w-]+)/view(?:\?|$)')
STUDY_FILENAME = re.compile(r'(A[0-9]+)\.pdf', re.I)
VERSION = re.compile(r'^(?:codex[\s_–—-]+)?(codebook|coding|codificaci[oó]n)[\s_–—-]*(?:(?:version|versión|v|tanda|batch)[\s_.–—-]*)?(\d{1,6})(?=$|[\s_(.–—-])', re.I)
CODES_COLUMNS = ('Code ID', 'Code', 'Description')
CODING_COLUMNS = ('StudyID', 'Challenge', 'Evidence Quote', 'Page', 'Justification', 'Context')
BATCH_REFRESH_SECONDS = 60
BATCH_CACHE = INDEX.parent / 'batches'
BATCH_LOCKS = {}
BATCH_LOCK = threading.Lock()
CHAT_SLOTS = threading.BoundedSemaphore(2)
CHAT_LOCK = threading.Lock()
CHAT_REQUESTS = deque()
LOG = logging.getLogger(__name__)


class InvalidComparison(ValueError):
    pass


class Folder(HTMLParser):
    def __init__(self, link_pattern=SHEET_ID):
        super().__init__(convert_charrefs=True)
        self.link_pattern = link_pattern
        self.files = []
        self.current = None
        self.label = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.current = self.link_pattern.match(dict(attrs).get('href', ''))
            self.label = []

    def handle_data(self, data):
        if self.current:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.current:
            self.files.append((''.join(self.label).strip(), self.current[1]))
            self.current = None


def read(url):
    with urlopen(url, timeout=12) as response:
        data = response.read(12_000_001)
    if len(data) > 12_000_000:
        raise ValueError('La respuesta de Drive excede el límite de lectura.')
    return data.decode('utf-8-sig')


def version_catalog(sheets):
    groups = {'codebook': {}, 'coding': {}}
    for title, file_id in sheets:
        match = VERSION.match(title)
        if match and int(match[2]) > 0:
            role = 'codebook' if match[1].lower() == 'codebook' else 'coding'
            version = int(match[2])
            groups[role].setdefault(version, {})[file_id] = title
    versions = {}
    seen = groups['codebook'].keys() | groups['coding'].keys()
    for version in sorted(seen):
        files = {role: by_version.get(version, {}) for role, by_version in groups.items()}
        if any(len(matches) != 1 for matches in files.values()):
            continue
        versions[version] = {}
        for role, matches in files.items():
            file_id, title = next(iter(matches.items()))
            versions[version][role] = {'id': file_id, 'title': title, 'url': f'{SHEET}{file_id}/edit'}
    if not versions:
        raise ValueError('Drive no muestra una pareja de hojas con el mismo número.')
    return versions, sorted(seen - versions.keys())


def table(source, columns):
    source_rows = csv.reader(io.StringIO(read(f"{SHEET}{source['id']}/export?format=csv"), newline=''))
    header = next(source_rows, [])
    rows = source_rows
    if header and not set(columns).issubset(header):
        # Some workbooks have CSV pasted as text, with later fields spilling into adjacent cells.
        header = next(csv.reader([','.join(header).rstrip(',')]))
        rows = (next(csv.reader([','.join(row).rstrip(',')]), []) for row in source_rows)
    if not set(columns).issubset(header):
        raise ValueError(f"La hoja {source['title']} no tiene las columnas esperadas.")
    records = (dict(zip(header, row)) for row in rows)
    return [{key: row.get(key, '') for key in columns} for row in records if row.get(columns[0], '').strip()]


def read_batch(version, sources):
    # IDs are included so replacing a workbook refreshes just that version.
    file_ids = [sources[role]['id'] for role in ('codebook', 'coding')]
    fingerprint = sha256(':'.join(file_ids).encode()).hexdigest()
    path = BATCH_CACHE / f'v{version}-{fingerprint}.json'
    with BATCH_LOCK:
        lock = BATCH_LOCKS.setdefault(path.name, threading.Lock())
    with lock:
        try:
            batch = json.loads(path.read_text(encoding='utf-8'))
            return version, batch['codes'], batch['coding']
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError):
            LOG.warning('Se omitió la caché de la versión %s.', version)
        codes = table(sources['codebook'], CODES_COLUMNS)
        coding = table(sources['coding'], CODING_COLUMNS)
        if not codes or not coding:
            raise ValueError(f'La versión {version} todavía tiene una hoja vacía.')
        temp = None
        try:
            BATCH_CACHE.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(mode='w', encoding='utf-8', dir=BATCH_CACHE, delete=False) as output:
                temp = Path(output.name)
                json.dump({'codes': codes, 'coding': coding}, output, ensure_ascii=False)
            temp.replace(path)
        except OSError:
            LOG.warning('No se pudo guardar la caché de la versión %s.', version)
        finally:
            if temp:
                with suppress(OSError):
                    temp.unlink(missing_ok=True)
        return version, codes, coding


def papers():
    folder = Folder(PDF_ID)
    folder.feed(read(PAPERS_VIEW))
    found = {}
    for title, file_id in folder.files:
        match = STUDY_FILENAME.fullmatch(title)
        if match:
            found.setdefault(match[1].upper(), set()).add(file_id)
    return {study: next(iter(ids)) for study, ids in found.items() if len(ids) == 1}


def paper_links():
    try:
        return {study: f'https://drive.google.com/file/d/{file_id}/view'
                for study, file_id in papers().items()}
    except (OSError, ValueError):
        return {}


def publication_dates():
    try:
        rows = table(PUBLICATIONS, ('StudyID', 'Fecha de publicación', 'Tipo'))
    except (OSError, ValueError):
        return {}
    dates = {}
    for row in rows:
        study = row['StudyID'].strip().upper()
        value = row['Fecha de publicación'].strip()
        if not re.fullmatch(r'A[0-9]+', study) or not re.fullmatch(r'[0-9]{4}(?:-[0-9]{2}){0,2}', value):
            continue
        try:
            date.fromisoformat(value + {4: '-01-01', 7: '-01', 10: ''}[len(value)])
        except ValueError:
            continue
        dates[study] = {'date': value, 'type': row['Tipo'].strip()}
    return dates


def cumulative_versions(batches, checkpoints):
    codes = {}
    titles = {}
    coding = {}
    introductions = {}
    snapshots = {}
    for version, version_codes, version_coding in batches:
        for row in version_codes:
            code = row['Code ID'].strip().upper()
            codes[code] = {**row, 'Code ID': code}
            titles[row['Code'].strip().casefold()] = code
        for row in version_coding:
            challenge = row['Challenge'].strip()
            match = re.match(r'C[0-9]+\b', challenge, re.I)
            code = match[0].upper() if match else titles.get(challenge.casefold())
            study = row['StudyID'].strip().upper()
            quote = ' '.join(row['Evidence Quote'].split())
            if code in codes and study and quote:
                introductions.setdefault(study, version)
                key = (code, study, row['Page'].strip(), quote)
                coding[key] = {**row, 'Challenge': code, 'StudyID': study}
        if version in checkpoints:
            snapshots[version] = {'version': version, 'codes': list(codes.values()),
                                  'coding': list(coding.values()), 'introductions': dict(introductions)}
    return snapshots


def snapshot_keys(versions):
    # An earlier batch also affects every later cumulative version.
    digest = sha256(b'codebook-snapshot-v2')
    keys = {}
    for number, pair in versions.items():
        digest.update(json.dumps([number, pair['codebook']['id'], pair['coding']['id']]).encode())
        keys[number] = digest.hexdigest()
    return keys


def chart_maximum(snapshot):
    associations = {(row['Challenge'], row['StudyID']) for row in snapshot['coding']}
    counts = Counter(code for code, _ in associations)
    return max(counts.values(), default=0)


def available_batches(pool):
    folder = Folder()
    folder.feed(read(FOLDER_VIEW))
    versions, pending = version_catalog(folder.files)
    history = {number: pool.submit(read_batch, number, pair) for number, pair in versions.items()}
    batches = []
    for number, future in history.items():
        try:
            batches.append(future.result())
        except (ValueError, OSError):
            pending.append(number)
    return {number: versions[number] for number, _, _ in batches}, sorted(pending), batches


def review(destination=None, origin=None, manifest=False, requested=None):
    with ThreadPoolExecutor(max_workers=6) as pool:
        if requested is None:
            links = pool.submit(paper_links)
            publications = pool.submit(publication_dates)
        versions, pending, batches = available_batches(pool)
        if not versions:
            raise ValueError('Drive todavía no tiene una versión con ambas hojas listas.')
        keys = snapshot_keys(versions)
        if requested is not None:
            snapshots = cumulative_versions(batches, requested & keys.keys())
            return {'snapshots': [{**snapshot, 'key': keys[number]} for number, snapshot in snapshots.items()]}
        latest = max(versions)
        version = latest if destination is None else destination
        if version not in versions:
            raise InvalidComparison('La versión de destino no está disponible.')
        if origin is None:
            origin = version - 1 if version - 1 in versions else 0
        if origin != 0 and (origin not in versions or origin == version):
            raise InvalidComparison('Elegí una versión de origen distinta de la de destino.')
        checkpoints = {latest} if manifest else {version, origin, latest}
        snapshots = cumulative_versions(batches, checkpoints)
        metadata = {'version': version, 'sources': versions[version], 'pending': pending,
                    'versions': list(versions), 'snapshotKeys': keys,
                    'chartMaximum': chart_maximum(snapshots[latest])}
        if manifest:
            return {**metadata, 'originVersion': origin, 'papers': links.result(),
                    'publications': publications.result()}
        return {**snapshots[version], **metadata,
                'origin': snapshots.get(origin), 'papers': links.result(),
                'publications': publications.result()}


def version_parameter(query, name):
    values = query.get(name, [])
    if not values:
        return None
    if len(values) != 1 or not re.fullmatch(r'[0-9]{1,6}', values[0]):
        raise InvalidComparison('Número de versión inválido.')
    return int(values[0])


def requested_snapshots(query):
    values = query.get('snapshots')
    if values is None:
        return None
    if len(values) != 1 or not re.fullmatch(r'[0-9]{1,6}(?:,[0-9]{1,6}){0,3}', values[0]):
        raise InvalidComparison('Se pueden solicitar hasta cuatro versiones a la vez.')
    return {int(value) for value in values[0].split(',')}


def version_cache_loop():
    with ThreadPoolExecutor(max_workers=5) as pool:
        while True:
            try:
                available_batches(pool)
            except (ValueError, OSError):
                LOG.warning('No se pudo revisar Drive para precargar las versiones.')
            time.sleep(BATCH_REFRESH_SECONDS)


def index_loop():
    while True:
        try:
            found = papers()
            if found:
                update_index(found)
        except Exception:
            LOG.exception('No se pudo actualizar el índice de papers.')
        time.sleep(1800)


def chat_request(data):
    if not isinstance(data, dict):
        raise ValueError('Enviá una pregunta.')
    messages = data.get('messages')
    context = data.get('context')
    if not isinstance(messages, list) or not 1 <= len(messages) <= 15 or len(messages) % 2 == 0:
        raise ValueError('Revisá la conversación y volvé a intentar.')
    if not isinstance(context, dict):
        context = {}
    clean = []
    for i, item in enumerate(messages):
        role = 'assistant' if i % 2 else 'user'
        if not isinstance(item, dict) or item.get('role') != role:
            raise ValueError('Conversación inválida.')
        value = item.get('content')
        if not isinstance(value, str) or not value.strip() or len(value) > (8000 if i % 2 else 2000):
            raise ValueError('El mensaje supera el límite o está vacío.')
        clean.append({'role': role, 'content': value.strip()})
    if sum(len(item['content']) for item in clean) > 25000:
        raise ValueError('La conversación supera el límite. Empezá una nueva.')
    hint = {}
    study = context.get('document')
    if isinstance(study, str) and re.fullmatch(r'A[0-9]{1,8}', study):
        hint['study_id'] = study
    code = context.get('code')
    if isinstance(code, str) and re.fullmatch(r'C[0-9]{1,8}', code):
        hint['code_id'] = code
        title = context.get('title')
        if isinstance(title, str) and title.strip():
            hint['code_title'] = title.strip()[:240]
    return clean, hint


def start_chat(client):
    now = time.monotonic()
    with CHAT_LOCK:
        while CHAT_REQUESTS and now - CHAT_REQUESTS[0][0] >= 3600:
            CHAT_REQUESTS.popleft()
        if len(CHAT_REQUESTS) >= 60 or sum(
            ip == client and now - when < 600 for when, ip in CHAT_REQUESTS
        ) >= 6:
            return False
        if not CHAT_SLOTS.acquire(blocking=False):
            return False
        CHAT_REQUESTS.append((now, client))
        return True


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if urlsplit(self.path).path not in {'/api/chat', '/codebook/api/chat'}:
            self.send_error(404)
            return
        def error(status, message):
            self.send_data(status, json.dumps({'error': message}).encode(), 'application/json; charset=utf-8')
        origin = self.headers.get('Origin')
        if (self.headers.get('Sec-Fetch-Site') == 'cross-site'
                or (origin and urlsplit(origin).netloc != self.headers.get('Host'))):
            error(403, 'Abrí el chat desde el codebook.')
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 110_000 or self.headers.get_content_type() != 'application/json':
                raise ValueError('Revisá el tamaño y el formato del mensaje.')
            self.connection.settimeout(18)
            messages, context = chat_request(json.loads(self.rfile.read(size)))
        except (ValueError, OSError):
            error(400, 'El mensaje no tiene un formato válido o supera el límite.')
            return
        client = self.headers.get('X-Forwarded-For', '').split(',')[-1].strip() or self.client_address[0]
        if not start_chat(client):
            error(429, 'El chat está ocupado o alcanzaste el límite de consultas. Probá más tarde.')
            return
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.end_headers()

            def emit(event):
                payload = ': keep-alive\n\n' if event['type'] == 'heartbeat' else (
                    'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n')
                self.wfile.write(payload.encode())
                self.wfile.flush()

            emit({'type': 'status', 'text': 'Preparando la consulta…'})
            try:
                asyncio.run(run_chat(messages, context, emit))
            except TimeoutError:
                emit({'type': 'error', 'text': 'La consulta tardó demasiado. Probá con una pregunta más específica.'})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                LOG.exception('Falló una consulta del chat.')
                emit({'type': 'error', 'text': 'El asistente no pudo completar la consulta. Probá de nuevo.'})
        except OSError:
            pass
        finally:
            CHAT_SLOTS.release()

    def do_GET(self):
        request = urlsplit(self.path)
        path = request.path.removeprefix('/codebook') if request.path.startswith('/codebook/') else request.path
        if path == '/codebook':
            self.send_response(308)
            self.send_header('Location', '/codebook/')
            self.end_headers()
            return
        paper = re.fullmatch(r'/papers/(A[0-9]+)\.pdf', path)
        if paper:
            self.serve_paper(paper[1])
            return
        if path == '/api/review':
            try:
                query = parse_qs(request.query, keep_blank_values=True)
                result, status = review(version_parameter(query, 'destination'), version_parameter(query, 'origin'),
                                        manifest=query.get('manifest') == ['1'],
                                        requested=requested_snapshots(query)), 200
            except InvalidComparison as error:
                result, status = {'error': str(error)}, 400
            except ValueError as error:
                result, status = {'error': str(error)}, 502
            except OSError:
                result, status = {'error': 'No se pudo consultar Google Drive. Volvé a intentar.'}, 502
            self.send_data(status, json.dumps(result, ensure_ascii=False).encode(), 'application/json; charset=utf-8')
            return
        assets = {'/': ('index.html', 'text/html'), '/style.css': ('style.css', 'text/css'),
                  '/app.js': ('app.js', 'text/javascript'), '/chat.js': ('chat.js', 'text/javascript')}
        if path not in assets:
            self.send_error(404)
            return
        name, mime = assets[path]
        self.send_data(200, (ROOT / name).read_bytes(), mime + '; charset=utf-8')

    def serve_paper(self, study):
        try:
            file_id = papers().get(study)
            if file_id is None:
                self.send_error(404, 'Paper not found')
                return
            data = download(file_id)
        except (OSError, ValueError):
            self.send_error(502, 'Could not open this PDF. Use the Google Drive link.')
            return
        self.send_data(200, data, 'application/pdf', f'inline; filename="{study}.pdf"')

    def send_data(self, status, data, mime, disposition=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        if disposition:
            self.send_header('Content-Disposition', disposition)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    threading.Thread(target=version_cache_loop, daemon=True).start()
    threading.Thread(target=index_loop, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', 18361), Handler).serve_forever()
