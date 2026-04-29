/**
 * @format
 * Golden AMI Component Document Builder
 *
 * Pure utility function that generates the EC2 Image Builder component YAML
 * document for baking a Kubernetes Golden AMI. This contains all K8s-specific
 * install steps — the generic `GoldenAmiImageConstruct` knows nothing about
 * Kubernetes.
 *
 * Installed software:
 * - Docker + Docker Compose
 * - AWS CLI v2
 * - CloudWatch Agent (binary only — config written at runtime)
 * - containerd, runc, CNI plugins, crictl
 * - kubeadm, kubelet, kubectl
 * - ECR credential provider (kubelet ECR auth)
 * - Calico CNI manifests (pre-downloaded to /opt/calico)
 * - aws-cfn-bootstrap (cfn-signal)
 * - Helm
 * - K8sGPT (AI-powered Kubernetes diagnostics)
 * - Node.js 22 LTS (runtime for TypeScript bootstrap scripts via tsx)
 * - ArgoCD CLI (pre-baked; auth.py skips runtime GitHub download when present)
 * - kubectl-argo-rollouts plugin (pre-baked; control_plane.ts skips runtime GitHub download when present)
 * - Python 3.11 + boto3 + pyyaml + kubernetes (isolated venv at /opt/k8s-venv, for deploy scripts)
 *
 * Comments are intentionally stripped from the generated YAML to stay under
 * the 16 000-character EC2 Image Builder component limit. Explanations live
 * here in the TypeScript source.
 *
 * @example
 * ```typescript
 * const componentDoc = buildGoldenAmiComponent({
 *     imageConfig: configs.image,
 *     clusterConfig: configs.cluster,
 * });
 * ```
 */

import type { K8sImageConfig, KubernetesClusterConfig } from '../../config/kubernetes/index.js';

// =============================================================================
// TYPES
// =============================================================================

export interface GoldenAmiComponentInput {
    /** Image configuration with software versions to bake */
    readonly imageConfig: K8sImageConfig;
    /** Cluster configuration for Kubernetes version */
    readonly clusterConfig: KubernetesClusterConfig;
    /**
     * SSM parameter path for the scripts S3 bucket name (e.g. '/k8s/development/scripts-bucket').
     * The Image Builder instance resolves this at build time via aws ssm get-parameter,
     * then syncs the full k8s-bootstrap/ tree into /opt/k8s-bootstrap/ — eliminating the
     * per-boot S3 download that previously ran in the SSM bootstrap runner.
     */
    readonly scriptsBucketSsmPath: string;
    /**
     * Opaque string mixed into the component YAML so that changes to files
     * synced from S3 at bake time (e.g. sm-a/boot/steps/package.json) still
     * invalidate the content hash and force a new CfnImage / AMI bake.
     */
    readonly extraHash?: string;
}

// =============================================================================
// BUILDER
// =============================================================================

/**
 * Builds the EC2 Image Builder component YAML document.
 *
 * Installs containerd, kubeadm, kubelet, kubectl, and pre-downloads
 * Calico CNI manifests. Kubernetes components are installed but NOT started.
 * Cluster initialisation happens at runtime via user-data (kubeadm init/join).
 *
 * @param input - Image and cluster configuration containing software versions
 * @returns YAML string for `imagebuilder.CfnComponent.data`
 */
export function buildGoldenAmiComponent(input: GoldenAmiComponentInput): string {
    const { imageConfig, clusterConfig, scriptsBucketSsmPath, extraHash } = input;

    // Extract major.minor for Kubernetes dnf repo (e.g., '1.35')
    const k8sMinorVersion = clusterConfig.kubernetesVersion.split('.').slice(0, 2).join('.');

    // Compact "#hash" prefix (was "# scripts-hash: hash") to save bytes —
    // every char counts against the 16000-byte AWS::ImageBuilder::Component
    // Data limit. The hash exists solely to invalidate the component version
    // when source files change; the prefix carried no information.
    const extraHashComment = extraHash ? `#${extraHash}\n` : '';

    return `${extraHashComment}
name: GoldenAmiInstall
description: Install containerd, kubeadm, kubelet, kubectl, Calico, K8sGPT
schemaVersion: 1.0

phases:
  - name: build
    steps:
      - name: DetectArchitecture
        action: ExecuteBash
        inputs:
          commands:
            - |
              UNAME_ARCH=$(uname -m)
              case $UNAME_ARCH in
                x86_64)  ARCH=amd64; COMPOSE_ARCH=x86_64; CLI_ARCH=x86_64 ;;
                aarch64) ARCH=arm64; COMPOSE_ARCH=aarch64; CLI_ARCH=aarch64 ;;
                *) echo "ERROR: Unsupported architecture: $UNAME_ARCH"; exit 1 ;;
              esac
              sed -i '/^ARCH=/d; /^COMPOSE_ARCH=/d; /^CLI_ARCH=/d' /etc/environment
              echo "ARCH=$ARCH" >> /etc/environment
              echo "COMPOSE_ARCH=$COMPOSE_ARCH" >> /etc/environment
              echo "CLI_ARCH=$CLI_ARCH" >> /etc/environment
              echo "arch: $UNAME_ARCH -> ARCH=$ARCH"

      - name: UpdateSystem
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - dnf update -y
            - dnf install -y jq unzip tar iproute-tc conntrack-tools socat

      - name: InstallDocker
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - dnf install -y docker
            - systemctl enable docker
            - usermod -aG docker ec2-user
            - mkdir -p /usr/local/lib/docker/cli-plugins
            - curl -fsSL "https://github.com/docker/compose/releases/download/${imageConfig.bakedVersions.dockerCompose}/docker-compose-linux-$COMPOSE_ARCH" -o /usr/local/lib/docker/cli-plugins/docker-compose
            - chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

      - name: InstallAwsCli
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$CLI_ARCH.zip" -o /tmp/awscli.zip
            - unzip -qo /tmp/awscli.zip -d /tmp
            - /tmp/aws/install --update
            - rm -rf /tmp/awscli.zip /tmp/aws
            - aws --version

      - name: InstallCloudWatchAgent
        action: ExecuteBash
        inputs:
          commands:
            - dnf install -y amazon-cloudwatch-agent

      - name: KernelModulesAndSysctl
        action: ExecuteBash
        inputs:
          commands:
            - |
              cat > /etc/modules-load.d/k8s.conf <<EOF
              overlay
              br_netfilter
              EOF
              modprobe overlay
              modprobe br_netfilter
              cat > /etc/sysctl.d/k8s.conf <<EOF
              net.bridge.bridge-nf-call-iptables  = 1
              net.bridge.bridge-nf-call-ip6tables = 1
              net.ipv4.ip_forward                 = 1
              EOF
              sysctl --system

      - name: InstallContainerd
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment
              CONTAINERD_VERSION="${imageConfig.bakedVersions.containerd}"
              curl -fsSL "https://github.com/containerd/containerd/releases/download/v\${CONTAINERD_VERSION}/containerd-\${CONTAINERD_VERSION}-linux-\${ARCH}.tar.gz" -o /tmp/containerd.tar.gz
              tar -C /usr/local -xzf /tmp/containerd.tar.gz
              rm /tmp/containerd.tar.gz
              mkdir -p /usr/local/lib/systemd/system
              curl -fsSL "https://raw.githubusercontent.com/containerd/containerd/main/containerd.service" -o /usr/local/lib/systemd/system/containerd.service
              mkdir -p /etc/containerd
              containerd config default > /etc/containerd/config.toml
              sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
              systemctl daemon-reload
              systemctl enable containerd
              RUNC_VERSION="${imageConfig.bakedVersions.runc}"
              curl -fsSL "https://github.com/opencontainers/runc/releases/download/v\${RUNC_VERSION}/runc.\${ARCH}" -o /usr/local/sbin/runc
              chmod +x /usr/local/sbin/runc
              CNI_VERSION="${imageConfig.bakedVersions.cniPlugins}"
              mkdir -p /opt/cni/bin
              curl -fsSL "https://github.com/containernetworking/plugins/releases/download/v\${CNI_VERSION}/cni-plugins-linux-\${ARCH}-v\${CNI_VERSION}.tgz" -o /tmp/cni-plugins.tgz
              tar -C /opt/cni/bin -xzf /tmp/cni-plugins.tgz
              rm /tmp/cni-plugins.tgz
              CRICTL_VERSION="${imageConfig.bakedVersions.crictl}"
              curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/v\${CRICTL_VERSION}/crictl-v\${CRICTL_VERSION}-linux-\${ARCH}.tar.gz" -o /tmp/crictl.tar.gz
              tar -C /usr/local/bin -xzf /tmp/crictl.tar.gz
              rm /tmp/crictl.tar.gz
              crictl config --set runtime-endpoint=unix:///run/containerd/containerd.sock

      - name: InstallKubeadmKubeletKubectl
        action: ExecuteBash
        inputs:
          commands:
            - |
              cat > /etc/yum.repos.d/kubernetes.repo <<EOF
              [kubernetes]
              name=Kubernetes
              baseurl=https://pkgs.k8s.io/core:/stable:/v${k8sMinorVersion}/rpm/
              enabled=1
              gpgcheck=1
              gpgkey=https://pkgs.k8s.io/core:/stable:/v${k8sMinorVersion}/rpm/repodata/repomd.xml.key
              EOF
              dnf install -y kubelet-${clusterConfig.kubernetesVersion} kubeadm-${clusterConfig.kubernetesVersion} kubectl-${clusterConfig.kubernetesVersion} --disableexcludes=kubernetes
              systemctl enable kubelet

      - name: InstallEcrCredentialProvider
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment
              ECR_PROVIDER_VERSION="${imageConfig.bakedVersions.ecrCredentialProvider}"
              curl -fsSL \
                "https://storage.googleapis.com/k8s-artifacts-prod/binaries/cloud-provider-aws/\${ECR_PROVIDER_VERSION}/linux/$ARCH/ecr-credential-provider-linux-$ARCH" \
                -o /usr/local/bin/ecr-credential-provider \
                || { echo "FATAL: ecr-credential-provider download failed"; exit 1; }
              chmod +x /usr/local/bin/ecr-credential-provider
              mkdir -p /etc/kubernetes
              cat > /etc/kubernetes/image-credential-provider-config.yaml <<CREDEOF
              apiVersion: kubelet.config.k8s.io/v1
              kind: CredentialProviderConfig
              providers:
                - name: ecr-credential-provider
                  matchImages:
                    - "*.dkr.ecr.*.amazonaws.com"
                  defaultCacheDuration: "12h"
                  apiVersion: credentialprovider.kubelet.k8s.io/v1
              CREDEOF

      - name: PreloadCalicoCNI
        action: ExecuteBash
        inputs:
          commands:
            - |
              mkdir -p /opt/calico
              CALICO_VERSION="${imageConfig.bakedVersions.calico}"
              curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/\${CALICO_VERSION}/manifests/tigera-operator.yaml" -o /opt/calico/tigera-operator.yaml
              curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/\${CALICO_VERSION}/manifests/calico.yaml" -o /opt/calico/calico.yaml
              echo "\${CALICO_VERSION}" > /opt/calico/version.txt

      - name: InstallCfnBootstrap
        action: ExecuteBash
        inputs:
          commands:
            - dnf install -y aws-cfn-bootstrap
            - test -f /opt/aws/bin/cfn-signal

      - name: InstallHelm
        action: ExecuteBash
        inputs:
          commands:
            - curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
            - helm version --short

      - name: InstallArgoCdCli
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment; export HOME=/root
              ARGOCD_VERSION="${imageConfig.bakedVersions.argoCdCli}"
              curl -fsSL \
                "https://github.com/argoproj/argo-cd/releases/download/\${ARGOCD_VERSION}/argocd-linux-\${ARCH}" \
                -o /usr/local/bin/argocd \
                || { echo "FATAL: ArgoCD CLI download failed"; exit 1; }
              chmod +x /usr/local/bin/argocd
              argocd version --client --short || { echo "FATAL: argocd not runnable"; exit 1; }

      - name: InstallKubectlArgoRollouts
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment; export HOME=/root
              ROLLOUTS_VERSION="${imageConfig.bakedVersions.kubectlArgoRollouts}"
              curl -fsSL \
                "https://github.com/argoproj/argo-rollouts/releases/download/\${ROLLOUTS_VERSION}/kubectl-argo-rollouts-linux-\${ARCH}" \
                -o /usr/local/bin/kubectl-argo-rollouts \
                || { echo "FATAL: rollouts download failed"; exit 1; }
              chmod +x /usr/local/bin/kubectl-argo-rollouts
              kubectl-argo-rollouts version || { echo "FATAL: rollouts not runnable"; exit 1; }

      - name: InstallK8sGPT
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment; export HOME=/root
              K8SGPT_VERSION="${imageConfig.bakedVersions.k8sgpt}"
              curl -fsSL "https://github.com/k8sgpt-ai/k8sgpt/releases/download/v\${K8SGPT_VERSION}/k8sgpt_amd64.rpm" \
                -o /tmp/k8sgpt.rpm || { echo "FATAL: k8sgpt download failed"; exit 1; }
              rpm -ivh /tmp/k8sgpt.rpm || { echo "FATAL: k8sgpt RPM install failed"; exit 1; }
              rm /tmp/k8sgpt.rpm
              k8sgpt version || { echo "FATAL: k8sgpt not runnable"; exit 1; }

      - name: InstallNodejs
        action: ExecuteBash
        inputs:
          commands:
            - curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
            - dnf install -y nodejs
            - node --version
            - npm --version
            - npm install -g tsx@4

      - name: InstallPythonDependencies
        action: ExecuteBash
        inputs:
          commands:
            - |
              dnf install -y python3.11 python3.11-pip
              python3.11 -m venv /opt/k8s-venv
              /opt/k8s-venv/bin/pip install --upgrade pip
              /opt/k8s-venv/bin/pip install boto3 pyyaml kubernetes bcrypt
              /opt/k8s-venv/bin/python3 -c "import boto3; print('boto3', boto3.__version__)"
              python3 -c "import sys; assert sys.version_info < (3, 11), f'System python3 must remain 3.9, got {sys.version}'; print(f'system python3 is \$SYS_PY_VERSION')"

      - name: BakeBootstrapScripts
        action: ExecuteBash
        inputs:
          commands:
            - |
              IMDS_TOKEN=$(curl -sf --max-time 5 -X PUT \
                "http://169.254.169.254/latest/api/token" \
                -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
              REGION=$(curl -sf --max-time 5 \
                -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
                "http://169.254.169.254/latest/meta-data/placement/region")
              if [ -z "$REGION" ]; then echo "FATAL: Could not resolve region from IMDSv2"; exit 1; fi
              SCRIPTS_BUCKET=$(aws ssm get-parameter \
                --name "${scriptsBucketSsmPath}" \
                --region "$REGION" \
                --query "Parameter.Value" \
                --output text)
              if [ -z "$SCRIPTS_BUCKET" ] || [ "$SCRIPTS_BUCKET" = "None" ]; then
                echo "FATAL: SSM parameter ${scriptsBucketSsmPath} not found"
                exit 1
              fi
              mkdir -p /opt/k8s-bootstrap
              aws s3 sync "s3://$SCRIPTS_BUCKET/k8s-bootstrap/" /opt/k8s-bootstrap/ \
                --region "$REGION" --exact-timestamps
              FILE_COUNT=$(find /opt/k8s-bootstrap -type f | wc -l | tr -d ' ')
              if [ "$FILE_COUNT" -lt 5 ]; then
                echo "FATAL: Only $FILE_COUNT file(s) synced — run 'just sync-k8s-bootstrap' first"
                exit 1
              fi
              find /opt/k8s-bootstrap -name "*.py" -exec chmod +x {} \\;
              find /opt/k8s-bootstrap -name "*.sh" -exec chmod +x {} \\;
              npm i --prefix /opt/k8s-bootstrap/sm-a/boot/steps --omit=dev --no-audit --no-fund
              npm i --prefix /opt/k8s-bootstrap/sm-a/argocd --omit=dev --no-audit --no-fund
              echo "Bootstrap scripts baked: $FILE_COUNT files"

      - name: CreateDataDirectory
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /data/kubernetes /data/k8s-bootstrap /data/app-deploy

  - name: validate
    steps:
      - name: VerifyInstallations
        action: ExecuteBash
        inputs:
          commands:
            - echo "[validate] docker:" && docker --version
            - echo "[validate] aws-cli:" && aws --version
            - echo "[validate] cloudwatch-agent:" && (/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status || echo "binary present")
            - echo "[validate] containerd:" && containerd --version
            - echo "[validate] runc:" && runc --version
            - echo "[validate] crictl:" && crictl --version
            - echo "[validate] kubeadm:" && kubeadm version -o short
            - echo "[validate] kubelet:" && kubelet --version
            - echo "[validate] kubectl:" && kubectl version --client -o yaml | grep gitVersion
            - test -f /opt/calico/calico.yaml && echo "[validate] calico.yaml present"
            - test -f /etc/containerd/config.toml && echo "[validate] containerd config present"
            - test -f /etc/sysctl.d/k8s.conf && echo "[validate] sysctl k8s config present"
            - test -f /opt/aws/bin/cfn-signal && echo "[validate] cfn-signal present"
            - echo "[validate] helm:" && helm version --short
            - echo "[validate] cloud-init:" && cloud-init status
            - |
              SYS_PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
              if [ "$SYS_PY_VERSION" = "3.11" ]; then
                echo "FATAL: System python3 overridden to 3.11 — cloud-init will break!"
                exit 1
              fi
              echo "[validate] system python3 is $SYS_PY_VERSION"
            - /opt/k8s-venv/bin/python3 -c "import sys; assert sys.version_info >= (3, 11)"
            - /opt/k8s-venv/bin/python3 -c "import boto3; print('[validate] boto3', boto3.__version__)"
            - /opt/k8s-venv/bin/python3 -c "import yaml; print('[validate] pyyaml ok')"
            - /opt/k8s-venv/bin/python3 -c "import kubernetes; print('[validate] kubernetes', kubernetes.__version__)"
            - /opt/k8s-venv/bin/python3 -c "import bcrypt; print('[validate] bcrypt ok')"
            - test -f /usr/local/bin/ecr-credential-provider && echo "[validate] ecr-credential-provider present"
            - test -f /etc/kubernetes/image-credential-provider-config.yaml && echo "[validate] credential provider config present"
            - |
              export HOME=/root
              echo "[validate] k8sgpt:" && k8sgpt version
            - |
              export HOME=/root
              echo "[validate] argocd:" && argocd version --client --short
            - test -f /usr/local/bin/kubectl-argo-rollouts && echo "[validate] kubectl-argo-rollouts present"
            - kubectl-argo-rollouts version
            - echo "[validate] node:" && node --version
            - echo "[validate] npm:" && npm --version
            - tsx --version
            - test -d /opt/k8s-bootstrap/sm-a/boot && echo "[validate] sm-a/boot/ scripts baked"
            - test -d /opt/k8s-bootstrap/sm-a/argocd && echo "[validate] sm-a/argocd/ scripts baked"
            - test -d /opt/k8s-bootstrap/gitops && echo "[validate] gitops/ manifests baked"
            - test -f /opt/k8s-bootstrap/sm-a/boot/steps/orchestrator.ts && echo "[validate] orchestrator.ts present"
            - test -f /opt/k8s-bootstrap/sm-a/boot/steps/control_plane.ts && echo "[validate] control_plane.ts present"
            - test -f /opt/k8s-bootstrap/sm-a/boot/steps/worker.ts && echo "[validate] worker.ts present"
            - test -f /opt/k8s-bootstrap/sm-a/argocd/bootstrap_argocd.ts && echo "[validate] bootstrap_argocd.ts present"
`;

}
