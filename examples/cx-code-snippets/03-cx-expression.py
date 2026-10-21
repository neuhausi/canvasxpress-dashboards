# title: Gene expression by sample (Python canvasxpress)
# source: canvasxpress (Python)
from canvasxpress.canvas import CanvasXpress
from canvasxpress.data.keypair import CXDictData
g = CanvasXpress(
    data=CXDictData({'y': {
        'vars': ['TP53', 'BRCA1', 'EGFR'],
        'smps': ['S1', 'S2', 'S3', 'S4'],
        'data': [[8.2, 7.1, 9.0, 6.4], [5.5, 6.2, 5.9, 7.3], [9.8, 8.4, 7.2, 8.9]]}}),
    config={'graphType': 'Heatmap', 'title': 'Gene expression by sample'})
