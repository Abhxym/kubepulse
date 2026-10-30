# Demo video script (about 6-8 minutes)

Record with OBS / Xbox Game Bar (`Win + Alt + R`) / Loom. Keep a terminal and the browser side by side.

## 0. Intro (30 s)
> "Hi, I'm <name>, PRN <prn>. This is KubePulse - a Node.js dashboard I containerized with Docker and deployed on Kubernetes using minikube. The UI shows which pod served each request, so we can *see* Kubernetes working."

Show the repo on GitHub and the folder structure briefly.

## 1. Dockerfile (1 min)
Open `Dockerfile` and explain:
- multi-stage: **stage 1 runs the tests**, stage 2 is the slim runtime
- `node:20-alpine`, zero npm dependencies -> ~48 MB image
- runs as non-root `node` user, `HEALTHCHECK`, exec-form `CMD` for graceful shutdown

```powershell
docker build -t kubepulse:1.0 .          # point at "# pass 7"
docker images kubepulse
```

## 2. Container execution (1 min)
```powershell
docker run -d -p 8080:8080 --name kubepulse kubepulse:1.0
docker ps --filter name=kubepulse        # (healthy)
docker logs kubepulse
```
Open http://localhost:8080 -> "env · local", node = docker-host.
```powershell
docker rm -f kubepulse
```

## 3. Kubernetes deployment (2 min)
```powershell
minikube start --driver=docker
minikube image load kubepulse:1.0
kubectl apply -f k8s/
kubectl rollout status deployment/kubepulse -n kubepulse
kubectl get deploy,rs,pods -n kubepulse -o wide
```
Open `k8s/02-deployment.yaml` - explain **replicas: 3**, RollingUpdate, **requests/limits**, **startup/liveness/readiness probes**, ConfigMap, Downward API, securityContext.

## 4. Service (1 min)
```powershell
kubectl get svc -n kubepulse
kubectl describe svc kubepulse-service -n kubepulse     # endpoints = 3 pod IPs
minikube service kubepulse-service -n kubepulse          # keep this window open
```
Browser: env · minikube, pod name, node = minikube, namespace = kubepulse.

## 5. Live demos (2 min)
1. **Load balancing** - click *Send requests* (150) -> three pods share traffic evenly.
2. **Self-healing** - in a second terminal run `kubectl get pods -n kubepulse -w`, then click *Crash a pod*. RESTARTS goes 0 -> 1, the timeline shows FAILOVER and RECOVERED.
3. **Scaling** - `kubectl scale deployment/kubepulse --replicas=5 -n kubepulse`, send requests again -> 5 pods appear.
4. **Logs** - `kubectl logs -l app=kubepulse -n kubepulse --tail=5 --prefix`

## 6. Wrap-up (30 s)
> "To summarise: Docker gave us an immutable, tested image; the Deployment keeps 3 healthy replicas with resource limits and probes; the Service gives a stable endpoint and load-balances; and Kubernetes self-heals and scales without downtime."
