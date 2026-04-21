import { buildGoldenAmiComponentYaml } from './lib/constructs/compute/build-golden-ami-component.js';

const yaml = buildGoldenAmiComponentYaml({
  bakedVersions: {
    kubernetesVersion: '1.31',
    containerd: '1.7.22',
    runc: '1.1.13',
    cniPlugins: '1.5.1',
    critools: '1.31.1',
    helm: 'v3.17.1',
    argoCdCli: 'v2.14.11',
    kubectlArgoRollouts: 'v0.34.0',
    k8sgpt: '0.4.30',
  },
});

console.log('YAML length:', yaml.length);
console.log('Over limit by:', yaml.length - 16000);

const lines = yaml.split('\n');
lines.forEach((l, i) => {
  if (l.includes('export HOME') || l.includes('FATAL:')) {
    console.log(`L${i+1}: ${l}`);
  }
});
