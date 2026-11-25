"""Index and read the papers in the review's Drive folder by physical PDF page."""
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import subprocess
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen

INDEX = Path(os.environ.get('STATE_DIRECTORY', '/tmp/mtgenai-review')) / 'papers.sqlite3'
ID = re.compile(r'A[0-9]{1,8}')
LOG = logging.getLogger(__name__)


def download(file_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', file_id):
        raise ValueError('Identificador de Drive inválido.')
    url = f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t'
    limit = 64_000_000
    with urlopen(url, timeout=25) as response:
        data = response.read(limit + 1)
    if len(data) > limit or not data.startswith(b'%PDF-'):
        raise ValueError('El archivo no es un PDF legible de menos de 64 MB.')
    return data


def extract(file_id):
    data = download(file_id)
    result = subprocess.run(['/usr/bin/pdftotext', '-enc', 'UTF-8', '-', '-'], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
    pages = result.stdout.decode('utf-8', errors='replace').split('\f')
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def update_index(papers):
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(INDEX) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS papers(study TEXT PRIMARY KEY, file_id TEXT, pages INTEGER, blurb TEXT);
            CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(study UNINDEXED, page UNINDEXED, body,
                                                              tokenize="unicode61 remove_diacritics 2");
        ''')
        existing = dict(db.execute('SELECT study, file_id FROM papers'))
        for study in existing.keys() - papers.keys():
            db.execute('DELETE FROM pages WHERE study = ?', (study,))
            db.execute('DELETE FROM papers WHERE study = ?', (study,))
        db.commit()
        missing = {study: file_id for study, file_id in papers.items() if existing.get(study) != file_id}
        with ThreadPoolExecutor(max_workers=5) as pool:
            tasks = [(study, file_id, pool.submit(extract, file_id)) for study, file_id in sorted(missing.items())]
            for study, file_id, task in tasks:
                try:
                    all_pages = task.result()
                except (OSError, ValueError, subprocess.SubprocessError):
                    LOG.warning('No se pudo indexar %s.', study)
                    continue
                if not any(page.strip() for page in all_pages):
                    LOG.warning('Sin texto extraíble en %s.', study)
                    continue
                blurb = ' '.join(next(page for page in all_pages if page.strip()).split())[:500]
                with db:
                    db.execute('DELETE FROM pages WHERE study = ?', (study,))
                    db.executemany('INSERT INTO pages VALUES (?, ?, ?)',
                                   ((study, i, page) for i, page in enumerate(all_pages, 1)))
                    db.execute('INSERT OR REPLACE INTO papers VALUES (?, ?, ?, ?)',
                               (study, file_id, len(all_pages), blurb))


TOOLS = [
    {'name': 'listar_papers', 'description': 'Lista un tramo del catálogo con StudyID, páginas y el comienzo del paper. Útil para identificar documentos por título o inspeccionar la cobertura.',
     'inputSchema': {'type': 'object', 'properties': {'desde': {'type': 'integer', 'minimum': 0}},
                     'additionalProperties': False}},
    {'name': 'buscar_papers', 'description': 'Busca términos en el texto de todas las páginas indexadas. Usá términos distintivos en el idioma del paper. Opcionalmente acotá por StudyID. Leé las páginas relevantes antes de citarlas.',
     'inputSchema': {'type': 'object', 'properties': {'consulta': {'type': 'string'}, 'estudio': {'type': 'string'}},
                     'required': ['consulta'], 'additionalProperties': False}},
    {'name': 'leer_paginas', 'description': 'Lee hasta tres páginas físicas del PDF de origen. Usá los números de página devueltos por buscar_papers.',
     'inputSchema': {'type': 'object', 'properties': {'estudio': {'type': 'string'}, 'pagina': {'type': 'integer'},
                                                    'cantidad': {'type': 'integer'}},
                     'required': ['estudio', 'pagina'], 'additionalProperties': False}},
]


def query(name, args, sources):
    if not isinstance(args, dict):
        raise ValueError('Argumentos inválidos.')
    if not INDEX.is_file():
        raise ValueError('El índice de papers se está preparando.')
    with sqlite3.connect(f'{INDEX.as_uri()}?mode=ro', uri=True) as db:
        if name == 'listar_papers':
            offset = args.get('desde', 0)
            if type(offset) is not int or not 0 <= offset <= 1000:
                raise ValueError('Posición inválida.')
            rows = db.execute('SELECT study, pages, blurb FROM papers ORDER BY study LIMIT 20 OFFSET ?', (offset,)).fetchall()
            total = db.execute('SELECT count(*) FROM papers').fetchone()[0]
            return {'total_indexados': total, 'siguiente_desde': offset + len(rows) if offset + len(rows) < total else None,
                    'papers': [{'estudio': study, 'paginas': pages, 'inicio': blurb} for study, pages, blurb in rows]}
        study = args.get('estudio', '')
        if not isinstance(study, str) or (study and not ID.fullmatch(study.upper())):
            raise ValueError('StudyID inválido.')
        study = study.upper()
        if name == 'buscar_papers':
            text = args.get('consulta')
            if not isinstance(text, str) or not 1 <= len(text) <= 240:
                raise ValueError('La consulta debe tener entre 1 y 240 caracteres.')
            terms = list(dict.fromkeys(w for w in re.findall(r'[^\W_]+', text.casefold()) if len(w) > 1))[:12]
            if not terms:
                raise ValueError('Incluí al menos un término de búsqueda.')
            match = ' OR '.join(f'"{word}"' for word in terms)
            rows = db.execute('''
                SELECT study, page, snippet(pages,2,'[',']',' … ',42)
                FROM pages WHERE pages MATCH ? AND (? = '' OR study = ?) ORDER BY rank LIMIT 14
            ''', (match, study, study)).fetchall()
            return [{'estudio': found, 'pagina': page, 'extracto': snippet} for found, page, snippet in rows]
        if name != 'leer_paginas':
            raise ValueError('Herramienta no disponible.')
        start, length = args.get('pagina'), args.get('cantidad', 1)
        if not study or type(start) is not int or type(length) is not int or not 1 <= start <= 10000 or not 1 <= length <= 3:
            raise ValueError('Indicá un StudyID y entre una y tres páginas a partir de una página válida.')
        rows = db.execute('SELECT page, body FROM pages WHERE study = ? AND page BETWEEN ? AND ? ORDER BY page',
                          (study, start, start + length - 1)).fetchall()
        if not rows:
            raise ValueError('No se encontraron esas páginas en el índice.')
        for page, body in rows:
            if body.strip():
                sources.add((study, page))
        return [{'estudio': study, 'pagina': page, 'texto': body[:18000], 'truncado': len(body) > 18000}
                for page, body in rows]
