<#
  KubePulse - one-click build & deploy to minikube (Windows PowerShell)
  Usage:  .\deploy.ps1            # build, load, deploy, open
          .\deploy.ps1 -Clean     # delete everything from the cluster
#>
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$Image = 'kubepulse:1.0'
$Ns    = 'kubepulse'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

if ($Clean) {
    Step "Removing KubePulse from the cluster"
    kubectl delete -f k8s/ --ignore-not-found
    exit 0
}

Step "Checking minikube"
$status = minikube status --format '{{.Host}}' 2>$null
if ($status -ne 'Running') { minikube start --driver=docker }
minikube addons enable metrics-server | Out-Null

Step "Building image $Image (tests run inside the build)"
docker build -t $Image .

Step "Loading image into minikube"
minikube image load $Image

Step "Applying Kubernetes manifests"
kubectl apply -f k8s/

Step "Waiting for rollout"
kubectl rollout status deployment/kubepulse -n $Ns --timeout=120s

Step "Cluster state"
kubectl get deploy,rs,pods,svc,hpa -n $Ns -o wide

Step "Opening the service (keep this window open on Windows)"
minikube service kubepulse-service -n $Ns
