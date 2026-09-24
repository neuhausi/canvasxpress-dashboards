/**
 * canvasxpress-dashboards — compose, coordinate, and render dashboards of
 * linked CanvasXpress visualizations from a declarative spec.
 *
 * @module canvasxpress-dashboards
 */

export { renderDashboard } from './renderDashboard.js';
export { validateSpec } from './validateSpec.js';
export {
  migrateSpec, dashboardDiff, dashboardsEqual, serializeSpec, canonicalSpec, specCompatibility,
  parseSchemaVersion, DASHBOARD_SCHEMA_VERSION, DASHBOARD_SCHEMA_URL, MIGRATIONS
} from './spec.js';
export { dashboardCss, injectStyles } from './styles.js';
export { createDataStore, isEmptyData, DataError, clearSharedCache, pushdownQuery } from './dataStore.js';
export { joinData, joinCycle, derivedCycle, sourceInputs, joinProvenance, matchIds, sourceAxis, tableFields, tableColumn, JOIN_TYPES } from './join.js';
export { resolveFields, summarizeField, rowsPassing, normalizeState } from './filters.js';
export { hasRelationships, relationGraph, translateMarks } from './marking.js';
export { exportSpec, importSpecFromFile, parseAndValidate, createDashboardClient } from './persistence.js';
export {
  inlineSpecData, buildDashboardHtml, exportDashboardHtml,
  dashboardToPng, exportDashboardPng, exportDashboardPdf
} from './exportDashboard.js';
export { createBuilder, pointerToCell, csvToCx, buildDataSource } from './builder.js';
export {
  addPanel, removePanel, movePanel, resizePanel, resolveCollisions, updatePanel, setDataSource, updateSettings, blankSpec, DEFAULT_COLS
} from './builderModel.js';

/** @type {string} Package version. */
export var version = '0.10.0';
