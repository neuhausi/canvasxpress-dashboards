/**
 * canvasxpress-dashboards — compose, coordinate, and render dashboards of
 * linked CanvasXpress visualizations from a declarative spec.
 *
 * @module canvasxpress-dashboards
 */

export { renderDashboard, resizeInstance } from './renderDashboard.js';
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
export { mountComments } from './comments.js';
export { mountAsk } from './ask.js';
export { exportSpec, importSpecFromFile, parseAndValidate, createDashboardClient } from './persistence.js';
export {
  inlineSpecData, buildDashboardHtml, exportDashboardHtml,
  dashboardToPng, exportDashboardPng, exportDashboardPdf,
  panelToSvg, exportPanelSvg, panelToPdf, exportPanelPdf,
  buildBundleFiles, buildReproducibleBundle, exportReproducibleBundle
} from './exportDashboard.js';
export { zipSync } from './zip.js';
export { sha256Hex } from './hash.js';
export { createBuilder, pointerToCell, csvToCx, buildDataSource } from './builder.js';
export {
  addPanel, removePanel, movePanel, resizePanel, resolveCollisions, updatePanel, setDataSource, updateSettings, blankSpec, DEFAULT_COLS,
  addRelationship, removeRelationship, setMarkingMode, buildJoinSource, encodeKeys, describeLink, MARKING_MODES,
  setCalculatedField, removeCalculatedField, describeCalculatedField, setSourcePushdown, addQueryControl
} from './builderModel.js';
export { runPushdown, rowsToCx, PUSHDOWN_FUNCTIONS } from './pushdown.js';
export {
  derivePanelMethod, panelProvenanceText, describeSource, describePushdown,
  describeCalculatedFields, describeStatOptions
} from './provenance.js';
export { tableFromData, profileColumns, applyDecimalComma, wizardSpec,
  sqlParamNames, paramNameFor, choicesSql, detailSql, connectorSourceUrl, databaseExplorerSpec, orientConfig,
  WIZARD_CHART_TYPES, chartFieldsFor, buildChartConfig, chartColumns,
  detectDataShapes, suggestPanelType,
  WIZARD_SCIENCE_TYPES, scientificFieldsFor, buildScientificConfig } from './wizard.js';
export { suggestDashboard, dashboardSpec } from './suggestDashboard.js';
export { mountInsights, insightsDrill } from './insights.js';
export { mountStoryboard, storyboardSteps } from './storyboard.js';
export { renderPayload } from './renderPayload.js';
export { transposeCxData } from './join.js';
export { hypergeometricPValue, benjaminiHochberg, enrich, enrichmentToData } from './enrichment.js';
export { pAdjust, significanceStars, applyDashboardCorrection, buildPanelStatInference, buildEffectSizeTile } from './statInference.js';
export { TRANSFORM_METHODS, TRANSFORM_LABELS, log2Row, log10Row, zscoreRow, medianCenterRow, quantileNormalize, transformData } from './transforms.js';
export { applyFdrThreshold, fdrVerdict, buildFdrSliderControl, buildTransformControl, batchCorrectionSource, describeAnalysisControl, describeAnalysisControls } from './analysisControls.js';
export { parseVcf, vcfToData, variantsPerChromosome } from './vcf.js';
export {
  JOURNAL_PRESETS, mmToPx, figureDimensions,
  composeFigureModel, composeFigureSvg, exportFigureSvg,
  composeFigurePdf, exportFigurePdf
} from './figureComposer.js';

/** @type {string} Package version. */
export var version = '0.13.0';
