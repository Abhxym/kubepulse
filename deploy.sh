#!/usr/bin/env bash
# KubePulse - one-click build & deploy to minikube (Linux / macOS / Git Bash)
set -euo pipefail

IMAGE="kubepulse:1.0"
NS="kubepulse"

if [[ "${1:-}" == "--clean" ]]; then
  kubectl delete -f k8s/ --ignore-not-found
  exit 0
fi

minikube status >/dev/null 2>&1 || minikube start --driver=docker
minikube addons enable metrics-server >/dev/null

docker build -t "$IMAGE" .
minikube image load "$IMAGE"
kubectl apply -f k8s/
kubectl rollout status deployment/kubepulse -n "$NS" --timeout=120s
kubectl get deploy,rs,pods,svc,hpa -n "$NS" -o wide
minikube service kubepulse-service -n "$NS"
