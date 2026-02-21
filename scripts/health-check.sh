#!/bin/bash
# Noesis Ship Health Check Script for DGX

echo "=== Noesis Ship Health Check ==="
echo "Timestamp: $(date)"
echo ""

# Check services
echo "--- Services ---"
for service in nats-server noesis-ship-websocket noesis-ship-agent-daemon; do
    status=$(systemctl is-active $service 2>/dev/null)
    if [ "$status" = "active" ]; then
        echo "✓ $service: $status"
    else
        echo "✗ $service: $status"
    fi
done

echo ""
echo "--- Network ---"
for port in 4222 3100 8222; do
    if netstat -tulpn 2>/dev/null | grep -q ":$port " || ss -tulpn 2>/dev/null | grep -q ":$port "; then
        echo "✓ Port $port: listening"
    else
        echo "✗ Port $port: not listening"
    fi
done

echo ""
echo "--- NATS Health ---"
if command -v jq &> /dev/null; then
    curl -s http://localhost:8222/varz | jq -r '"Connections: \(.connections) | Uptime: \(.uptime)"' 2>/dev/null || echo "✗ NATS monitoring unavailable"
else
    curl -s http://localhost:8222/varz > /dev/null 2>&1 && echo "✓ NATS monitoring available" || echo "✗ NATS monitoring unavailable"
fi

echo ""
echo "--- Agent API Health ---"
if command -v jq &> /dev/null; then
    curl -s http://localhost:3102/health | jq . 2>/dev/null || echo "✗ Agent API unavailable"
else
    curl -s http://localhost:3102/health > /dev/null 2>&1 && echo "✓ Agent API available" || echo "✗ Agent API unavailable"
fi

echo ""
echo "=== End Health Check ==="
