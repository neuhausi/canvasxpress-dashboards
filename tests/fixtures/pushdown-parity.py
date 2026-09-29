# Regenerate tests/fixtures/pushdown-parity.json: run each query through the REAL
# canvasxpress-connectors pushdown (SQLite) and record its CanvasXpress output, so
# tests/pushdown.test.js can check the browser executor gives the same answer.
#   CX_CONNECTORS_SRC=<canvasxpress-connectors>/src python3 tests/fixtures/pushdown-parity.py
# results + the base data object (via the connector's own rows_to_cx).
import json, os, sqlite3, sys
sys.path.insert(0, os.environ.get('CX_CONNECTORS_SRC', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'canvasxpress-connectors', 'src')))
from cx_connectors.pushdown import run_pushdown
from cx_connectors.reshape import rows_to_cx
import tempfile
db = os.path.join(tempfile.mkdtemp(), 'pushdown-parity.sqlite')
if os.path.exists(db): os.remove(db)
rows = [
  ('r1', 'EMEA', 'A', 10.0, 1.0, 1), ('r2', 'EMEA', 'B', 25.0, None, 2), ('r3', 'APAC', 'A', 40.0, 3.0, 1),
  ('r4', 'APAC', 'C', 5.0, 4.0, 3), ('r5', 'AMER', 'B', 60.0, 2.0, 2), ('r6', 'EMEA', 'A', 30.0, 5.0, 1),
  ('r7', '', 'C', 20.0, 1.0, 3), ('r8', 'AMER', 'A', 15.0, None, 1), ('r9', 'APAC', 'B', 35.0, 6.0, 2),
  ('r10', 'EMEA', 'C', 50.0, 2.0, 3),
]
con = sqlite3.connect(db)
con.execute('CREATE TABLE t (id TEXT, region TEXT, product TEXT, amount REAL, units REAL, qty INTEGER)')
con.executemany('INSERT INTO t VALUES (?,?,?,?,?,?)', rows); con.commit(); con.close()
header = ['id', 'region', 'product', 'amount', 'units', 'qty']
# The browser source: what a dataset of these rows looks like. units has NULLs,
# so rows_to_cx makes it an annotation; carry it numeric like a CSV upload would.
base = rows_to_cx(header, [list(r) for r in rows])
base['y']['vars'].insert(1, 'units'); base['y']['data'].insert(1, [r[4] for r in rows]); del base['x']['units']
Q = {
 'grouped_all_fns': {'groupBy': ['region'], 'measures': [{'fn': 'count'}, {'fn': 'count_distinct', 'column': 'product'},
     {'fn': 'sum', 'column': 'amount'}, {'fn': 'avg', 'column': 'units'}, {'fn': 'min', 'column': 'amount'},
     {'fn': 'max', 'column': 'amount'}, {'fn': 'count', 'column': 'units', 'as': 'units_n'}], 'orderBy': ['region']},
 'no_groupby': {'measures': [{'fn': 'count', 'as': 'n'}, {'fn': 'sum', 'column': 'amount', 'as': 'total'}]},
 'no_rows_no_groupby': {'measures': [{'fn': 'count'}], 'where': [{'column': 'region', 'op': '=', 'value': 'nowhere'}]},
 'two_keys_desc_limit': {'groupBy': ['region', 'product'], 'measures': [{'fn': 'sum', 'column': 'amount', 'as': 's'}],
     'where': [{'column': 'amount', 'op': '>=', 'value': 20}], 'orderBy': [{'column': 's', 'desc': True}], 'limit': 3},
 'avg_of_nulls': {'groupBy': ['region'], 'measures': [{'fn': 'avg', 'column': 'units', 'as': 'u'}],
     'where': [{'column': 'units', 'op': 'is_null'}], 'orderBy': ['region']},
 'ops_mix': {'groupBy': ['product'], 'measures': [{'fn': 'count', 'as': 'n'}], 'orderBy': ['product'],
     'where': [{'column': 'region', 'op': 'in', 'value': ['EMEA', 'APAC', '']}, {'column': 'amount', 'op': 'between', 'value': [10, 40]},
               {'column': 'qty', 'op': '!=', 'value': 3}, {'column': 'units', 'op': 'not_null'}]},
 'not_in_and_lt': {'groupBy': ['region'], 'measures': [{'fn': 'mean', 'column': 'amount'}], 'orderBy': ['region'],
     'where': [{'column': 'product', 'op': 'not_in', 'value': ['C']}, {'column': 'amount', 'op': '<', 'value': 50}]},
 'numeric_key': {'groupBy': ['qty'], 'measures': [{'fn': 'count', 'as': 'n'}], 'orderBy': ['qty']},
 'empty_string_is_a_value': {'groupBy': ['region'], 'measures': [{'fn': 'count', 'as': 'n'}], 'orderBy': ['region'],
     'where': [{'column': 'region', 'op': '=', 'value': ''}]},
 'rows_mode': {'columns': ['id', 'region', 'amount'], 'where': [{'column': 'product', 'op': 'in', 'value': ['A', 'B']}],
     'orderBy': [{'column': 'amount', 'desc': True}], 'limit': 4},
}
out = {'base': base, 'results': {}}
for name, q in Q.items():
    h, rs, _ = run_pushdown('sqlite:///' + db, 'SELECT * FROM t', None, q)
    try:
        res = rows_to_cx(h, rs)
    except ValueError as e:
        res = {'error': str(e)}
    out['results'][name] = {'query': q, 'db': res}
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pushdown-parity.json'), 'w'), indent=1)
print('wrote', len(Q), 'db results')
