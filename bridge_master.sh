#!/bin/bash

# --- CONFIGURATION ---
# Format: port_forward <namespace> <service_name> <internal_port> <container_port>

function port_forward {
    echo "[+] Bridging $1/$2: Local $3 -> Container $4"
    # Run in background, silence output
    kubectl port-forward --namespace "$1" service/challenge "$3":"$4" --address 127.0.0.1 > /dev/null 2>&1 &
}

# Cleanup old forwards
echo "Stopping old bridges..."
pkill -f "kubectl port-forward"
sleep 2

echo "Starting Bridges..."

# --- PWN CHALLENGES (TCP) ---
# Map Internal 4001 -> kCTF 1337
port_forward "pwn-easy-01" "challenge" 4001 1337

# --- WEB CHALLENGES (HTTP) ---
# Map Internal 5001 -> kCTF 80 (Standard Web Port)
port_forward "web-easy-01" "challenge" 5001 80

# Keep script running
wait
