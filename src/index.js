/**
 * canvasxpress-dashboards — compose, coordinate, and render dashboards of
 * linked CanvasXpress visualizations from a declarative spec.
 *
 * @module canvasxpress-dashboards
 */

export { renderDashboard } from './renderDashboard.js';
export { validateSpec } from './validateSpec.js';
export { dashboardCss, injectStyles } from './styles.js';
export { createDataStore, isEmptyData, DataError, clearSharedCache } from './dataStore.js';
export { exportSpec, importSpecFromFile, parseAndValidate, createDashboardClient } from './persistence.js';
export { createBuilder, pointerToCell } from './builder.js';
export {
  addPanel, removePanel, movePanel, resizePanel, updatePanel, setDataSource, blankSpec, DEFAULT_COLS
} from './builderModel.js';

/** @type {string} Package version. */
export var version = '0.4.0';
