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

/** @type {string} Package version. */
export var version = '0.2.0';
