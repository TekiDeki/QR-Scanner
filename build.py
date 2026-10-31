#!/usr/bin/env python3
"""Builds the single-file index.html: styles + inlined ZXing + i18n + app.

Deterministic: same sources, same bytes. `src/styles.css` deliberately ends without a
trailing newline - the template adds the newline before </style>, and a second one would
change the built file.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'src'
VENDOR = ROOT / 'vendor' / 'zxing.min.js'
OUT = ROOT / 'index.html'

template = (SRC / 'template.html').read_text(encoding='utf-8')
styles = (SRC / 'styles.css').read_text(encoding='utf-8')
i18n = (SRC / 'i18n.js').read_text(encoding='utf-8')
app = (SRC / 'app.js').read_text(encoding='utf-8')
vendor = VENDOR.read_text(encoding='utf-8')

for marker, content in (('/*__STYLES__*/', styles), ('/*__VENDOR__*/', vendor), ('/*__I18N__*/', i18n), ('/*__APP__*/', app)):
    assert marker in template, marker
    template = template.replace(marker, content)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(template, encoding='utf-8')
size = OUT.stat().st_size
print('built', OUT, size, 'bytes')
