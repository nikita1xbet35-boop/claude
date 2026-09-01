"""PDF со справочником ГЕО → CSV.

Запуск:  python3 parse_geo_pdf.py Work_GEOs.pdf geo.csv
Нужен:   pip install pypdfium2

Ник присылает обновлённый PDF по мере изменений (ТЗ §1), поэтому разборщик
лежит в репозитории, а не остаётся одноразовым скриптом.


Разбор по прямоугольникам ячеек, а не склейкой символов.

Почему не проще. По пробелам нельзя: названия стран и списки языков сами
содержат пробелы. Склейка символов строки по x тоже не работает — шрифт
крошечный, перенос внутри ячейки идёт всего в 3pt ниже, а буквы p/g/y — в 1-2pt,
и цепочка выносных дотягивается до строки переноса. Результат: наложенные
тексты вида 'SReepvSahraatree' вместо 'Separate RevShare'. Разделить их по
координате низа нельзя в принципе.

Поэтому границы колонок берутся из пустых вертикальных коридоров документа,
границы строк — из колонки Availability (там перенос не встречается), а текст
каждой ячейки извлекает сам pdfium из прямоугольника, соблюдая порядок чтения.
"""
import pypdfium2 as pdfium, csv, re, sys
from collections import defaultdict, Counter

PDF = sys.argv[1] if len(sys.argv) > 1 else 'geo.pdf'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'geo.csv'

AVAIL = ['Local program only', 'Confirm with manager', 'Not available', 'Available']
MAP = {'Available':'available', 'Not available':'not_available',
       'Local program only':'local_program_only', 'Confirm with manager':'confirm_with_manager'}

def corridors(doc):
    """Вертикальные полосы, не занятые ни одним символом ни на одной странице."""
    occ = [False] * 900
    for pi in range(len(doc)):
        tp = doc[pi].get_textpage()
        for i in range(tp.count_chars()):
            l, b, r, t = tp.get_charbox(i)
            if tp.get_text_range(i, 1).strip():
                for x in range(int(l), min(int(r) + 1, 899)): occ[x] = True
    out, start = [], None
    for x in range(60, 830):
        if not occ[x]:
            if start is None: start = x
        else:
            if start is not None and x - start >= 3: out.append((start + x) / 2)
            start = None
    return out

def row_baselines(pg, first_col_right):
    """Базовые линии строк — по колонке Availability: там значение всегда
    однострочное (проверено: все четыре варианта помещаются в строку), поэтому
    её вертикальные позиции и есть разметка строк таблицы."""
    tp = pg.get_textpage()
    ys = defaultdict(int)
    for i in range(tp.count_chars()):
        l, b, r, t = tp.get_charbox(i)
        ch = tp.get_text_range(i, 1)
        if ch.strip() and l < first_col_right: ys[round(b)] += 1  # вся первая колонка
    # схлопываем соседние (выносные буквы дают низ на 1-2pt ниже)
    out, prev = [], None
    for y in sorted(ys, reverse=True):
        if prev is None or prev - y > 4: out.append(y)
        prev = y
    return out

def main():
    doc = pdfium.PdfDocument(PDF)
    bounds = corridors(doc)
    print(f'коридоров: {len(bounds)} → колонок: {len(bounds)+1}', file=sys.stderr)
    # Крайние границы — по краям страницы, а не по началу колонки: длинные
    # значения не помещаются в свою колонку и вылезают левее. «Confirm with
    # manager» начинается на x=47.4 при колонке от 63, и обрезка по 55 съедала
    # «Co», из-за чего три страны с этим статусом молча выпадали из выгрузки.
    xs = [0] + bounds + [842]

    rows = []
    for pi in range(len(doc)):
        pg = doc[pi]; tp = pg.get_textpage()
        base = row_baselines(pg, bounds[0])
        for k, y in enumerate(base):
            # Полоса строки: от середины до предыдущей базовой линии до
            # середины до следующей. Так вертикально центрированные ячейки
            # (примечание в три строки вокруг основной) попадают целиком.
            top    = (base[k-1] + y) / 2 if k > 0 else y + 10
            bottom = (base[k+1] + y) / 2 if k + 1 < len(base) else y - 10
            cells = [
                (tp.get_text_bounded(left=xs[c], bottom=bottom, right=xs[c+1], top=top) or '')
                .replace('\r', ' ').replace('\n', ' ').strip()
                for c in range(len(xs) - 1)
            ]
            cells = [re.sub(r'\s+', ' ', c) for c in cells]
            if cells[0].startswith('Availability'): continue
            avail = next((a for a in AVAIL if cells[0].startswith(a)), None)
            if not avail: continue
            note = cells[8] if len(cells) > 8 else ''
            rows.append({
                'geo_en': cells[0][len(avail):].strip(),
                'geo_ru': cells[1], 'iso_code': cells[2], 'region': cells[3],
                'availability': MAP[avail],
                'note': '' if note in ('—', '-', '') else note,
            })

    with open(OUT, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['geo_en','geo_ru','iso_code','region','availability','note'])
        w.writeheader()
        for r in rows: w.writerow(r)
    print(f'строк: {len(rows)}', file=sys.stderr)
    print('статусы:', Counter(r['availability'] for r in rows).most_common(), file=sys.stderr)
    return rows

if __name__ == '__main__':
    rows = main()
    print('\n--- проблемные ранее строки ---')
    for n in ('Bangladesh','Russia','Andorra','Belarus','Abkhazia','Zimbabwe'):
        m = [r for r in rows if r['geo_en'] == n]
        print(' ', m[0] if m else f'{n}: НЕ НАЙДЕНО')
