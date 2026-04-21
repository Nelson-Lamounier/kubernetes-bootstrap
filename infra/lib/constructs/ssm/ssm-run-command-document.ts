/**
 * @format
 * SSM Run Command Document Construct
 *
 * Reusable construct for creating SSM Command documents.
 * Supports parameterized shell scripts that can be executed
 * via SSM Run Command against EC2 instances — without requiring
 * EC2 replacement or CDK stack redeployment.
 *
 * @example
 * ```typescript
 * const doc = new SsmRunCommandDocument(this, 'ConfigureApp', {
 *     documentName: 'my-app-configure',
 *     description: 'Download and configure the application stack',
 *     parameters: {
 *         S3BucketName: { type: 'String', description: 'S3 bucket with app bundle' },
 *         Region: { type: 'String', default: 'eu-west-1' },
 *     },
 *     steps: [
 *         {
 *             name: 'downloadBundle',
 *             commands: [
 *                 'aws s3 sync s3://{{S3BucketName}}/scripts/ /opt/app/ --region {{Region}}',
 *             ],
 *         },
 *     ],
 * });
 * ```
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface SsmDocumentParameter {
    readonly type: 'String' | 'StringList' | 'Boolean' | 'Integer' | 'MapList';
    readonly description?: string;
    readonly default?: string;
    readonly allowedValues?: string[];
}

export interface SsmRunCommandStep {
    readonly name: string;
    readonly commands: string[];
    readonly workingDirectory?: string;
    readonly timeoutSeconds?: number;
}

export interface SsmRunCommandDocumentProps {
    readonly documentName: string;
    readonly description?: string;
    readonly parameters?: Record<string, SsmDocumentParameter>;
    readonly steps: SsmRunCommandStep[];
    readonly tags?: cdk.CfnTag[];
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class SsmRunCommandDocument extends Construct {
    /** The underlying SSM CfnDocument resource */
    public readonly document: ssm.CfnDocument;

    /** The document name (used with aws ssm send-command) */
    public readonly documentName: string;

    constructor(scope: Construct, id: string, props: SsmRunCommandDocumentProps) {
        super(scope, id);

        this.documentName = props.documentName;

        const parameters: Record<string, unknown> = {};
        if (props.parameters) {
            for (const [key, param] of Object.entries(props.parameters)) {
                const paramDef: Record<string, unknown> = {
                    type: param.type,
                };
                if (param.description) paramDef.description = param.description;
                if (param.default !== undefined) paramDef.default = param.default;
                if (param.allowedValues) paramDef.allowedValues = param.allowedValues;
                parameters[key] = paramDef;
            }
        }

        const mainSteps = props.steps.map((step) => ({
            action: 'aws:runShellScript',
            name: step.name,
            inputs: {
                runCommand: [
                    '#!/bin/bash',
                    // NOTE: -u (nounset) is intentionally omitted. SSM Agent runs documents in a
                    // non-login, non-interactive shell where standard vars like $HOME are not
                    // guaranteed to be set. Using -u would cause an immediate fatal exit before
                    // any user commands run (manifests as "Error: $HOME is not defined").
                    'set -exo pipefail',
                    'export HOME="${HOME:-/root}"',
                    '',
                    `echo "=== SSM Step: ${step.name} started at $(date) ==="`,
                    '',
                    ...step.commands,
                    '',
                    `echo "=== SSM Step: ${step.name} completed at $(date) ==="`,
                ],
                workingDirectory: step.workingDirectory ?? '/tmp',
                timeoutSeconds: String(step.timeoutSeconds ?? 600),
            },
        }));

        this.document = new ssm.CfnDocument(this, 'Document', {
            documentType: 'Command',
            name: props.documentName,
            documentFormat: 'JSON',
            content: {
                schemaVersion: '2.2',
                description: props.description ?? `SSM Run Command: ${props.documentName}`,
                parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
                mainSteps,
            },
            tags: props.tags,
            updateMethod: 'NewVersion',
        });
    }
}
