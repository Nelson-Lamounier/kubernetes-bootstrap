/**
 * @format
 * Compute Constructs — Barrel Export
 *
 * Public API for all compute-related CDK constructs and utilities
 * in the kubernetes-bootstrap infra layer.
 */

export { GoldenAmiImageConstruct } from './golden-ami-image.js';
export type { GoldenAmiImageProps } from './golden-ami-image.js';

export { buildGoldenAmiComponent } from './build-golden-ami-component.js';
export type { GoldenAmiComponentInput } from './build-golden-ami-component.js';
