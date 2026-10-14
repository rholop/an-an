// Phase 40 D.1: the Azure Speech build engine (Phases 10 and 35), shared by `audio:build`
// (packages/data-pipeline) and the proxy's /v1/tutor-audio (apps/proxy). Node only.
export * from './azure.js';
export * from './build.js';
export * from './compare.js';
export * from './jobs.js';
