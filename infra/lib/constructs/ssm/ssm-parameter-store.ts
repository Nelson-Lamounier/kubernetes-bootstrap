/**
 * @format
 * SSM Parameter Store Construct (L3)
 *
 * Dynamic, reusable construct that creates a batch of SSM String Parameters
 * from a simple name→value record. Uses a for loop to iterate over entries
 * and auto-generates construct IDs and descriptions from the path.
 *
 * @example
 * ```typescript
 * new SsmParameterStoreConstruct(this, 'SsmParams', {
 *     parameters: {
 *         '/k8s/dev/vpc-id':     vpc.vpcId,
 *         '/k8s/dev/elastic-ip': eip.ref,
 *     },
 * });
 * ```
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface SsmParameterStoreConstructProps {
    readonly parameters: Record<string, string>;
    readonly tierOverrides?: Record<string, ssm.ParameterTier>;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class SsmParameterStoreConstruct extends Construct {
    /** Map of parameter name → created `ssm.StringParameter` */
    public readonly parameterMap: ReadonlyMap<string, ssm.StringParameter>;

    constructor(
        scope: Construct,
        id: string,
        props: SsmParameterStoreConstructProps,
    ) {
        super(scope, id);

        const map = new Map<string, ssm.StringParameter>();

        for (const [parameterName, stringValue] of Object.entries(props.parameters)) {
            const constructId = SsmParameterStoreConstruct._toConstructId(parameterName);
            const description = SsmParameterStoreConstruct._toDescription(parameterName);
            const tier = props.tierOverrides?.[parameterName] ?? ssm.ParameterTier.STANDARD;

            const param = new ssm.StringParameter(this, constructId, {
                parameterName,
                stringValue,
                description,
                tier,
            });

            map.set(parameterName, param);
        }

        this.parameterMap = map;
    }

    private static _toConstructId(parameterName: string): string {
        const lastSegment = parameterName.split('/').pop() ?? parameterName;
        const pascal = lastSegment
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
        return `${pascal}Param`;
    }

    private static _toDescription(parameterName: string): string {
        const lastSegment = parameterName.split('/').pop() ?? parameterName;
        return lastSegment
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
}
