/**
 * CDK Stack Registry — kubernetes-bootstrap
 *
 * Re-exports the shared stack utilities from `@nelsonlamounier/cdk-deploy-scripts/stacks.js`
 * and registers this repo's CDK projects at module-load time.
 *
 * Projects:
 *   - kubernetes  → K8s-SsmAutomation-{env}, K8s-GoldenAmi-{env}
 *
 * Consumer scripts import from this file (not directly from @repo/script-utils)
 * so project registration happens before any `getProject()` call.
 */

export {
  type DefaultConfig,
  type Environment,
  type ExtraContext,
  type ProjectConfig,
  type StackConfig,
  defaults,
  getAllStacksForProject,
  getEffectiveStacks,
  getProject,
  getRequiredContextMessage,
  getRequiredStacksForProject,
  getStack,
  profileMap,
  projectsMap,
} from '@nelsonlamounier/cdk-deploy-scripts/stacks.js';

import { registerProject } from '@nelsonlamounier/cdk-deploy-scripts/stacks.js';

// =============================================================================
// KUBERNETES PROJECT
// =============================================================================

registerProject({
  id: 'kubernetes',
  name: 'Kubernetes Bootstrap',
  description: 'SSM Automation + Golden AMI CDK stacks for the kubeadm cluster',
  stacks: [
    {
      id: 'ssmAutomation',
      name: 'SSM Automation',
      getStackName: (env) => `K8s-SsmAutomation-${env}`,
      description: 'Step Functions bootstrap orchestrator, SSM Automation documents, EventBridge rule',
    },
    {
      id: 'goldenAmi',
      name: 'Golden AMI',
      getStackName: (env) => `K8s-GoldenAmi-${env}`,
      description: 'EC2 Image Builder pipeline for the kubeadm golden AMI',
      optional: true,
    },
  ],
  cdkContext: (env) => ({
    project: 'kubernetes',
    environment: env,
  }),
});
